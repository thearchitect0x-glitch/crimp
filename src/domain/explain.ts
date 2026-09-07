// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Which clauses decided this, and nothing else.
 *
 * A determination that cannot say WHY is not usable by the buyers this product
 * is for. ECOA/Regulation B requires the specific principal reasons for an
 * adverse action, and CFPB Circular 2022-03 says explicitly that a complex
 * algorithm does not excuse a creditor from giving them. CMS-0057-F requires a
 * specific denial reason on prior authorization. "Our model declined you" is
 * not a reason anywhere.
 *
 * Crimp is the only party holding the rule that was applied, so it is the only
 * party that can derive the reason mechanically rather than reconstruct it.
 *
 * NO PROSE. Ever. A reason here is a structured reference to a clause of the
 * sealed rule — a path, a fact name, an operator, a literal. The moment a
 * generated sentence enters the decision record, the reproducibility the whole
 * product is sold on is gone, because a sentence cannot be re-derived.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE HAS TWO FIDELITIES, AND WHY THAT IS NOT TIMIDITY
 *
 * A reason set naming the clause leaks nothing: the caller submitted the rule
 * and already knows what is in it. A reason set carrying the OBSERVED VALUE
 * leaks two things that matter.
 *
 *   1. It discloses what the institution holds about a person, to whoever can
 *      call the endpoint.
 *   2. It collapses threshold discovery. Without it, learning where a cliff
 *      sits takes a binary search over repeated attest-and-seal cycles, which
 *      is slow, visible and expensive. With it, one call. That is the
 *      structuring vector Ratchet's `structuring.ts` exists to detect, handed
 *      out at the front desk.
 *
 * So `reasons()` is value-free and cheap, and `disclose()` — the form that
 * carries values — is a separate, higher-authority, RECORDED act. Asking why
 * somebody was refused is a legitimate and legally required thing to do, and
 * it is also exactly the probe an adversary runs. Both are true, so the answer
 * is not to refuse it but to make it accountable.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { evaluate } from './evaluate.js';
import {
  TRUE, FALSE, UNKNOWN, type Comparison, type Facts, type Rule, type Truth,
} from './rule.js';

/** A clause that helped decide the outcome, located within the rule. */
export interface Reason {
  /** Position in the rule tree, e.g. `all[1]` or `any[0].not`. Stable under canonical form. */
  path: string;
  fact: string;
  op: string;
  /** The literal the rule compared against. Part of the rule, so never a disclosure. */
  value: Comparison['value'];
  /** What this clause evaluated to. */
  truth: Truth;
  /**
   * Whether the clause sits under an odd number of `not`s.
   *
   * A `negated` reason carries the OPPOSITE truth to the outcome it explains:
   * "not(delivered = true)" refuses because the clause inside is TRUE. A notice
   * that states such a reason positively says the wrong thing, so the polarity
   * travels with the reason rather than being inferred from the path.
   *
   * It is also the invariant that makes over-reporting detectable — see
   * ACCURACY in test/unit/fuzz-explain.test.ts.
   *
   * A consumer may check it independently: it is the PARITY of `not` segments
   * in `path`, so `not.not.all[0]` is direct and `not.all[0]` is negated.
   */
  polarity: 'direct' | 'negated';
}

/** A reason with what was actually observed. Produced only by a recorded disclosure. */
export interface DisclosedReason extends Reason {
  /** The attested value that met or missed the clause. */
  observed: boolean | number | string | null;
  /** Where that value came from, and how admissible it is. */
  source: string | null;
  admissibility: string | null;
  /**
   * For an ordered comparison that failed: the nearest value that would have
   * satisfied it. The single most useful line in an adverse action notice, and
   * the single most dangerous one — it names the cliff exactly.
   */
  wouldHaveNeeded?: number;
}

function negate(t: Truth): Truth {
  return t === TRUE ? FALSE : t === FALSE ? TRUE : UNKNOWN;
}

/**
 * The clauses sufficient to establish `target`.
 *
 * The shape follows Kleene directly, which is why it is short enough to check
 * by eye:
 *
 *   all / FALSE     one false child decides it — every false child is an
 *                   independent principal reason
 *   all / TRUE      every child was necessary — all of them
 *   any / TRUE      one true child decides it — every true child independently
 *   any / FALSE     every child failed — all of them
 *   ... / UNKNOWN   the children that withheld an answer
 *   not             ask the inner rule for the opposite
 *
 * SUFFICIENCY IS THE INVARIANT, and it is fuzz-tested rather than argued:
 * re-evaluating the rule against only the facts these reasons name must give
 * the same answer. A reason set that does not actually determine the outcome
 * would be a false adverse action notice, which is its own ECOA problem.
 */
export function reasons(rule: Rule, facts: Facts, target?: Truth): Reason[] {
  const want = target ?? evaluate(rule, facts);
  return walk(rule, facts, want, '', false);
}

/**
 * Append one segment to a path.
 *
 * Segments are joined with `.` and never concatenated. The first version built
 * `${path}${kind}[${i}]` with no separator, so a nested clause landed at
 * `any[0]not.not` instead of `any[0].not.not` — which makes the polarity
 * unverifiable by a consumer counting `not` segments, and disagrees with the
 * example in SPEC.md §7.1. Found by fuzzing, not by the conformance vectors,
 * because those only nested `not` at the root.
 */
const join = (path: string, seg: string): string => (path === '' ? seg : `${path}.${seg}`);

function walk(rule: Rule, facts: Facts, want: Truth, path: string, negated: boolean): Reason[] {
  if ('all' in rule || 'any' in rule) {
    const kind = 'all' in rule ? 'all' : 'any';
    const children = 'all' in rule ? rule.all : rule.any;
    // The truth that decides a conjunction is FALSE; for a disjunction, TRUE.
    const deciding = kind === 'all' ? FALSE : TRUE;
    const out: Reason[] = [];
    children.forEach((child, i) => {
      const at = join(path, `${kind}[${i}]`);
      const t = evaluate(child, facts);
      // A decided outcome is explained only by the children that decided it.
      // An undecided one is explained by the children that withheld. Otherwise
      // every child was necessary and every child is a reason.
      const include = want === deciding ? t === deciding
        : want === UNKNOWN ? t === UNKNOWN
          : true;
      // Carry the REQUESTED truth down, never the child's actual one. They are
      // identical whenever the caller asked about the outcome that really
      // happened, which is every legitimate call. They diverge when somebody
      // asks why a determination was refused that was not refused — and there
      // the walk must run out of matching clauses and return nothing, rather
      // than quietly re-anchoring to reality and handing back clauses labelled
      // for an outcome nobody asked about.
      if (include) out.push(...walk(child, facts, want, at, negated));
    });
    return out;
  }
  if ('not' in rule) return walk(rule.not, facts, negate(want), join(path, 'not'), !negated);

  const c = rule as Comparison;
  const t = evaluate(c, facts);
  // A leaf that does not carry the truth being explained is not a reason for it.
  return t === want
    ? [{
      path: path === '' ? 'rule' : path, fact: c.fact, op: c.op, value: c.value, truth: t,
      polarity: negated ? 'negated' as const : 'direct' as const,
    }]
    : [];
}

/** Every fact a reason set names. What a disclosure would have to reveal. */
export function factsNamed(rs: readonly Reason[]): string[] {
  return [...new Set(rs.map((r) => r.fact))].sort();
}

/**
 * Add what was observed. Callers must have already established the authority
 * for this and recorded it — this function does neither, deliberately, so that
 * the gate cannot be bypassed by calling the wrong helper.
 */
export function disclose(
  rs: readonly Reason[], facts: Facts,
  provenance: Readonly<Record<string, { source: string; admissibility: string }>>,
): DisclosedReason[] {
  return rs.map((r) => {
    const f = facts[r.fact];
    const p = provenance[r.fact];
    const out: DisclosedReason = {
      ...r,
      observed: f === undefined ? null : f.value,
      source: p?.source ?? null,
      admissibility: p?.admissibility ?? null,
    };
    const need = nearestSatisfying(r, f?.value);
    if (need !== undefined) out.wouldHaveNeeded = need;
    return out;
  });
}

/**
 * For a failed ordered comparison on an integer, the nearest value that would
 * have satisfied it.
 *
 * Integers only, and that is not a limitation — the grammar refuses
 * non-integers precisely because "the nearest passing value" is meaningless
 * over the reals, and an adverse action notice saying "you needed marginally
 * less than 3" helps nobody.
 */
function nearestSatisfying(r: Reason, observed: unknown): number | undefined {
  if (r.truth !== FALSE || typeof r.value !== 'number' || typeof observed !== 'number') {
    return undefined;
  }
  switch (r.op) {
    case 'lt':  return r.value - 1;
    case 'lte': return r.value;
    case 'gt':  return r.value + 1;
    case 'gte': return r.value;
    default:    return undefined;
  }
}
