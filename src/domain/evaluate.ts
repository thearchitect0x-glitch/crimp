// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Rule evaluation: total, deterministic, and three-valued.
 *
 * WHY THREE VALUES. A rule that reads a fact nobody attested has not been
 * satisfied and has not been violated — it has not been answered. Collapsing
 * that into `false` is the same mistake as reporting an expired lease as
 * `failed`: it converts a known unknown into a confident wrong answer, and the
 * confident wrong answer is the one that reaches a customer. Ratchet made
 * `indeterminate` a first-class state for this reason; UNKNOWN is the same
 * doctrine one product over.
 *
 * The seal path refuses to seal a rule that evaluates to UNKNOWN. That is the
 * point: it forces the caller to attest what its own rule depends on before it
 * is allowed to decide anything, which is the discipline the whole product is
 * selling. An agent cannot decide on facts it never gathered.
 *
 * WHY IT CANNOT SEE A CLOCK. `now` is not a fact this evaluator supplies. Time
 * enters only as an attested value, because a rule whose answer depends on when
 * you ask it is not reproducible, and reproducibility is the product.
 */
import {
  TRUE, FALSE, UNKNOWN,
  type Truth, type Rule, type Comparison, type Facts, type Fact, type Op,
} from './rule.js';
import { ApiError } from '../lib/errors.js';
import { normalizeText } from '../lib/ids.js';

/** A rule whose literal type disagrees with the attested fact's type is a caller bug, not a missing answer. */
export class RuleTypeError extends ApiError {
  constructor(message: string, detail: Record<string, unknown>) {
    super(400, 'rule_type_mismatch', message, detail);
  }
}

const ORDERED = new Set<Op>(['lt', 'lte', 'gt', 'gte']);

/** Kleene conjunction: one FALSE decides it; otherwise any UNKNOWN withholds it. */
function and(parts: Truth[]): Truth {
  if (parts.includes(FALSE)) return FALSE;
  if (parts.includes(UNKNOWN)) return UNKNOWN;
  return TRUE;
}

/** Kleene disjunction: one TRUE decides it; otherwise any UNKNOWN withholds it. */
function or(parts: Truth[]): Truth {
  if (parts.includes(TRUE)) return TRUE;
  if (parts.includes(UNKNOWN)) return UNKNOWN;
  return FALSE;
}

function negate(t: Truth): Truth {
  return t === TRUE ? FALSE : t === FALSE ? TRUE : UNKNOWN;
}

/**
 * Evaluate a validated rule against attested facts.
 *
 * Throws `RuleTypeError` when a literal cannot be compared with the fact it
 * names. That is deliberately not UNKNOWN: missing data is a fact of the world,
 * but comparing a string to an integer is a mistake in the rule, and a mistake
 * in the rule must be refused loudly at seal time rather than absorbed.
 */
export function evaluate(rule: Rule, facts: Facts): Truth {
  if ('all' in rule) return and(rule.all.map((r) => evaluate(r, facts)));
  if ('any' in rule) return or(rule.any.map((r) => evaluate(r, facts)));
  if ('not' in rule) return negate(evaluate(rule.not, facts));
  return compare(rule as Comparison, facts);
}

function compare(c: Comparison, facts: Facts): Truth {
  const fact = facts[c.fact];
  if (fact === undefined) return UNKNOWN;

  assertComparable(c, fact);

  const left = fact.type === 'str' ? normalizeText(fact.value as string) : fact.value;

  switch (c.op) {
    case 'eq':  return truth(left === normalizeLiteral(c.value));
    case 'ne':  return truth(left !== normalizeLiteral(c.value));
    case 'lt':  return truth((left as number) < (c.value as number));
    case 'lte': return truth((left as number) <= (c.value as number));
    case 'gt':  return truth((left as number) > (c.value as number));
    case 'gte': return truth((left as number) >= (c.value as number));
    case 'in':  return truth(setOf(c.value).has(left as string | number));
    case 'nin': return truth(!setOf(c.value).has(left as string | number));
  }
}

function truth(b: boolean): Truth {
  return b ? TRUE : FALSE;
}

function normalizeLiteral(v: Comparison['value']): unknown {
  return typeof v === 'string' ? normalizeText(v) : v;
}

function setOf(v: Comparison['value']): Set<string | number> {
  const arr = v as (string | number)[];
  return new Set(arr.map((x) => (typeof x === 'string' ? normalizeText(x) : x)));
}

/**
 * The type rules, in one place so they can be read as a table:
 *
 *   bool  — eq, ne
 *   int   — eq, ne, lt, lte, gt, gte, in, nin
 *   time  — eq, ne, lt, lte, gt, gte, in, nin   (epoch millis; an int wearing a hat)
 *   str   — eq, ne, in, nin
 *
 * Ordered comparison on a string is refused rather than defined, because
 * lexicographic order over user data is a trap: it is locale-dependent in the
 * reader's head and byte-order in the machine, and the two disagree exactly
 * where somebody would rely on them agreeing.
 */
function assertComparable(c: Comparison, fact: Fact): void {
  const numeric = fact.type === 'int' || fact.type === 'time';

  if (ORDERED.has(c.op) && !numeric) {
    throw new RuleTypeError(
      `Operator "${c.op}" compares order and cannot be applied to a ${fact.type} fact.`,
      { fact: c.fact, op: c.op, factType: fact.type });
  }

  const expect = (v: unknown): void => {
    const got = typeof v;
    const want = numeric ? 'number' : fact.type === 'bool' ? 'boolean' : 'string';
    if (got !== want) {
      throw new RuleTypeError(
        `Fact "${c.fact}" is ${fact.type}; the rule compares it with a ${got}.`,
        { fact: c.fact, factType: fact.type, literalType: got });
    }
  };

  if (Array.isArray(c.value)) {
    if (fact.type === 'bool') {
      throw new RuleTypeError(`Operator "${c.op}" cannot be applied to a bool fact.`,
        { fact: c.fact, op: c.op });
    }
    c.value.forEach(expect);
    return;
  }
  expect(c.value);
}
