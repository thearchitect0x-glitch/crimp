// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The predicate grammar. Read this before changing anything in it.
 *
 * This is the single hardest constraint in the product. Every rule ever sealed
 * is evaluated by this grammar forever, and a sealed rule is a record an
 * examiner may re-run in 2032 and expect the same answer from. That means:
 *
 *   - the grammar cannot be narrowed, ever, without invalidating history;
 *   - it can only be widened in ways that leave every existing rule's meaning
 *     unchanged;
 *   - a bug in v1 semantics is a bug maintained for the life of the company,
 *     because the alternative is silently re-deciding decided cases.
 *
 * Everything below is therefore smaller than it wants to be.
 *
 * WHY IT IS NOT A LANGUAGE. No loops, no recursion, no user functions, no
 * arithmetic, no external calls, no clock. Evaluation is a bounded walk over a
 * bounded tree, so it is total: every rule terminates, and the only outcomes
 * are the three below. A grammar an examiner cannot read in full is a grammar
 * that cannot be examined, which defeats the point of sealing it.
 *
 * WHY THERE IS NO `present` / `absent` OPERATOR. It is the obvious omission and
 * it is deliberate. "No chargeback was filed" must be expressed by attesting
 * `chargeback_filed = false`, not by observing that nobody attested anything.
 * Otherwise a rule cannot distinguish "we checked and it is not there" from "we
 * never looked", and the second silently satisfies the first — which is exactly
 * the failure this product exists to prevent, rebuilt into its own foundation.
 * Forcing a positive attestation costs the caller one field and buys the
 * difference between evidence and absence of evidence.
 */
import { canonicalize } from '../lib/ids.js';
import { ApiError } from '../lib/errors.js';

/**
 * The semantics a sealed rule was evaluated under.
 *
 * Every seal records this. Widening the grammar in a way that leaves existing
 * rules' meaning unchanged does NOT bump it; anything that could change how an
 * already-sealed rule evaluates MUST, and the evaluator must then keep the old
 * semantics reachable. A version it cannot reproduce yields UNKNOWN, so the
 * determination becomes `tainted` rather than being silently re-decided under
 * rules nobody agreed to.
 */
export const GRAMMAR_VERSION = '1';
export const SUPPORTED_GRAMMAR_VERSIONS: ReadonlySet<string> = new Set([GRAMMAR_VERSION]);

/** Three-valued result. UNKNOWN is first-class, for the same reason Ratchet's `indeterminate` is. */
export const TRUE = 'true' as const;
export const FALSE = 'false' as const;
export const UNKNOWN = 'unknown' as const;
export type Truth = typeof TRUE | typeof FALSE | typeof UNKNOWN;

/** Ordered comparisons are legal only on ordered types; see `compare`. */
export const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'nin'] as const;
export type Op = (typeof OPS)[number];
const ORDERED_OPS = new Set<Op>(['lt', 'lte', 'gt', 'gte']);
const SET_OPS = new Set<Op>(['in', 'nin']);

/** The value types a fact may carry. Money is `int` in micro-USD, as in Ratchet. */
export const FACT_TYPES = ['bool', 'int', 'str', 'time'] as const;
export type FactType = (typeof FACT_TYPES)[number];

/** An attested fact: a value the customer's own systems asserted, with its type. */
export interface Fact {
  type: FactType;
  /** bool | integer | string | epoch-millis integer */
  value: boolean | number | string;
}
export type Facts = Readonly<Record<string, Fact>>;

export type Comparison = {
  fact: string;
  op: Op;
  value: boolean | number | string | (number | string)[];
};
export type Rule =
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | Comparison;

/* ── Limits ──────────────────────────────────────────────────────────────
 * Chosen to be generous for real policy and hostile to cleverness. A rule
 * that needs more than this is a rule nobody can audit, which means it is
 * not a rule, it is a program.
 */
export const LIMITS = {
  maxDepth: 8,
  maxNodes: 64,
  maxSetSize: 64,
  maxFactNameLength: 96,
  maxStringLength: 256,
} as const;

const FACT_NAME = /^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$/;

function bad(msg: string, detail?: Record<string, unknown>): never {
  throw new ApiError(400, 'invalid_rule', msg, detail);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structural validation. Runs without facts, because a malformed rule is a
 * caller bug regardless of what has been attested, and the caller deserves to
 * hear about it before anything is sealed.
 *
 * Returns the set of facts the rule references, which the seal path needs
 * anyway to enforce required fact classes.
 */
export function validateRule(rule: unknown): Set<string> {
  const facts = new Set<string>();
  let nodes = 0;

  const walk = (node: unknown, depth: number): void => {
    if (++nodes > LIMITS.maxNodes) {
      bad(`A rule may contain at most ${LIMITS.maxNodes} nodes.`, { limit: LIMITS.maxNodes });
    }
    if (depth > LIMITS.maxDepth) {
      bad(`A rule may nest at most ${LIMITS.maxDepth} levels deep.`, { limit: LIMITS.maxDepth });
    }
    if (!isPlainObject(node)) bad('Each rule node must be an object.');

    const keys = Object.keys(node).sort();

    if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
      const kids = node[keys[0]];
      if (!Array.isArray(kids)) bad(`"${keys[0]}" must be an array of rules.`);
      // An empty conjunction is vacuously true and an empty disjunction is
      // vacuously false. Both are ways to write a rule that decides nothing
      // while looking like it decides something. Refused rather than defined.
      if (kids.length === 0) bad(`"${keys[0]}" must contain at least one rule.`);
      for (const k of kids) walk(k, depth + 1);
      return;
    }

    if (keys.length === 1 && keys[0] === 'not') {
      walk(node['not'], depth + 1);
      return;
    }

    if (keys.length === 3 && keys[0] === 'fact' && keys[1] === 'op' && keys[2] === 'value') {
      const { fact, op, value } = node as Record<string, unknown>;
      if (typeof fact !== 'string' || !FACT_NAME.test(fact)) {
        bad(`Fact name ${JSON.stringify(fact)} is not usable. Names are lowercase dotted segments, `
          + 'letters, digits and underscores.', { fact });
      }
      if (fact.length > LIMITS.maxFactNameLength) bad(`Fact name exceeds ${LIMITS.maxFactNameLength} characters.`);
      if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
        bad(`Operator ${JSON.stringify(op)} is not one of: ${OPS.join(', ')}.`, { op });
      }
      validateLiteral(op as Op, value);
      facts.add(fact);
      return;
    }

    bad('A rule node must be exactly one of: {all}, {any}, {not}, or {fact, op, value}.',
      { received: keys });
  };

  walk(rule, 1);

  // A rule that references no fact cannot be wrong about anybody, which makes
  // it a decision with nothing behind it. `all: [ {…} ]` is unreachable here
  // because every leaf names a fact, but a future node type could reintroduce
  // this, so the check is explicit rather than implied.
  if (facts.size === 0) bad('A rule must reference at least one fact.');

  return facts;
}

function validateLiteral(op: Op, value: unknown): void {
  if (SET_OPS.has(op)) {
    if (!Array.isArray(value)) bad(`Operator "${op}" requires an array of values.`);
    if (value.length === 0) bad(`Operator "${op}" requires a non-empty array.`);
    if (value.length > LIMITS.maxSetSize) {
      bad(`Operator "${op}" accepts at most ${LIMITS.maxSetSize} values.`, { limit: LIMITS.maxSetSize });
    }
    const kinds = new Set(value.map((v) => typeof v));
    if (kinds.size !== 1) bad(`Operator "${op}" requires all values to be the same type.`);
    for (const v of value) scalarLiteral(v, op);
    return;
  }
  if (Array.isArray(value)) bad(`Operator "${op}" does not accept an array.`);
  scalarLiteral(value, op);
  if (ORDERED_OPS.has(op) && typeof value !== 'number') {
    bad(`Operator "${op}" compares order and requires a number.`, { op });
  }
}

function scalarLiteral(v: unknown, op: Op): void {
  if (typeof v === 'boolean') return;
  if (typeof v === 'number') {
    // Integers only. Floats make equality a lie and make two systems that
    // agree disagree; money is micro-USD everywhere in this codebase.
    if (!Number.isSafeInteger(v)) bad(`Numbers must be safe integers; received ${String(v)}.`, { op });
    return;
  }
  if (typeof v === 'string') {
    if (v.length > LIMITS.maxStringLength) bad(`Strings may be at most ${LIMITS.maxStringLength} characters.`);
    return;
  }
  bad(`Values must be boolean, integer or string; received ${v === null ? 'null' : typeof v}.`, { op });
}

/**
 * Canonical form: semantically identical rules produce identical bytes.
 *
 * `all` and `any` are commutative, so their children are sorted by their own
 * canonical form. That matters beyond tidiness — it is what lets two agents
 * that expressed the same policy in different orders be recognised as having
 * applied the same rule, which is the whole basis of asking whether like cases
 * were treated alike.
 *
 * The rule as WRITTEN is stored separately and unmodified. This form exists
 * only to be hashed and compared; an examiner is always shown the original.
 */
export function canonicalRule(rule: Rule): string {
  const norm = (node: Rule): unknown => {
    if ('all' in node) return { all: node.all.map(norm).map(canonicalize).sort().map((s) => JSON.parse(s)) };
    if ('any' in node) return { any: node.any.map(norm).map(canonicalize).sort().map((s) => JSON.parse(s)) };
    if ('not' in node) return { not: norm(node.not) };
    const c = node as Comparison;
    // Set members are compared as a set, so neither their order NOR their
    // multiplicity carries meaning. Sorting alone was not enough: `in ["CA"]`
    // and `in ["CA","CA"]` are the same rule and hashed differently, so two
    // identical policies produced two different determinations and neither
    // could be found from the other.
    //
    // Caught by the published conformance vectors, which were derived from the
    // specification by an independent implementation rather than from this
    // code. It is also the last moment this is free to fix: canonical form
    // decides the rule hash, so changing it after the first real determination
    // would silently orphan every determination sealed before the change.
    const value = Array.isArray(c.value)
      ? [...new Set(c.value.map((m) => JSON.stringify(m)))]
        .sort().map((m) => JSON.parse(m) as number | string)
      : c.value;
    return { fact: c.fact, op: c.op, value };
  };
  return canonicalize(norm(rule));
}

/** Every fact the rule reads. The seal path uses this to enforce required fact classes. */
export function factsReferenced(rule: Rule): Set<string> {
  const out = new Set<string>();
  const walk = (n: Rule): void => {
    if ('all' in n) return n.all.forEach(walk);
    if ('any' in n) return n.any.forEach(walk);
    if ('not' in n) return walk(n.not);
    out.add((n as Comparison).fact);
  };
  walk(rule);
  return out;
}

/**
 * Every ordered boundary the rule draws.
 *
 * This is what makes the cliff analysis possible: a threshold is a number
 * somebody chose, and counting how many people landed either side of it is the
 * only way to see how much consequence is hanging on that choice. Ratchet's
 * `structuring.ts` runs the same shape of comparison over amounts; this runs it
 * over rules.
 */
export interface Threshold { fact: string; op: Op; value: number }
export function thresholds(rule: Rule): Threshold[] {
  const out: Threshold[] = [];
  const walk = (n: Rule): void => {
    if ('all' in n) return n.all.forEach(walk);
    if ('any' in n) return n.any.forEach(walk);
    if ('not' in n) return walk(n.not);
    const c = n as Comparison;
    if (ORDERED_OPS.has(c.op) && typeof c.value === 'number') {
      out.push({ fact: c.fact, op: c.op, value: c.value });
    }
  };
  walk(rule);
  return out;
}
