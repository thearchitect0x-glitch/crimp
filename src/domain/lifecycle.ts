// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * What happens to a seal after it exists.
 *
 * Two mechanisms live here and they are the two the product is actually for.
 *
 * RE-EVALUATION gives the lifecycle for free, because the evaluator already has
 * three values and they already mean the right things.
 *
 * PRESSURE-HARDENING turns an attacker's own effort into the thing that locks
 * the door — and carries the safety valve that stops it becoming a weapon
 * pointed at real customers.
 */
import { TRUE, FALSE, UNKNOWN, type Truth } from './rule.js';
import { type ClawRule, rankOf, AUTHORITIES, type Authority } from './authority.js';
import { type Admissibility, dominates } from './admissibility.js';

export type SealState = 'sealed' | 'tainted' | 'lapsed' | 'clawed';

/**
 * Re-run the sealed rule against current attestations and read off the state.
 *
 *   TRUE    → stands. Nothing to do.
 *   FALSE   → lapsed. Reality withdrew its own support: no authority was
 *             involved, nobody was persuaded, nobody won an argument. This is
 *             the correction channel that does not require the affected person
 *             to have the resources to fight, and it is the only one that
 *             samples them without bias.
 *   UNKNOWN → tainted. The ground is gone but the claim is not disproved.
 *             Still binding, surfaced for review, NEVER auto-lifted — because
 *             lifting on an unknown is guessing, and guessing is the one thing
 *             a gate must not do.
 */
export function classify(truth: Truth): Extract<SealState, 'sealed' | 'tainted' | 'lapsed'> {
  switch (truth) {
    case TRUE: return 'sealed';
    case FALSE: return 'lapsed';
    case UNKNOWN: return 'tainted';
  }
}

/* ── Pressure ────────────────────────────────────────────────────────── */

export interface Pressure {
  /** Refused attempts inside the rolling window. */
  attempts: number;
  /** Distinct caller-declared sessions those attempts came from. */
  sessions: number;
}

export const PRESSURE_WINDOW_DAYS = 30;

export type PressureTier = 'none' | 'persistent' | 'probing' | 'sustained';

/**
 * A real customer denied something asks once, perhaps twice, then asks for a
 * human. An adversary probes: several sessions, over days, rephrasing, testing
 * which framing gets through. No legitimate user produces the second shape.
 *
 * Deliberately a counter and thresholds rather than a model. There is nothing
 * here to explain to an examiner beyond four numbers, and nothing to drift.
 */
export function tierOf(p: Pressure): PressureTier {
  if (p.attempts >= 25 && p.sessions >= 5) return 'sustained';
  if (p.attempts >= 10 && p.sessions >= 2) return 'probing';
  if (p.attempts >= 3) return 'persistent';
  return 'none';
}

/**
 * How hard it becomes to reverse a seal that is being worked.
 *
 * THE SAFETY VALVE, WITHOUT WHICH THIS IS A DENIAL-OF-SERVICE FEATURE:
 *
 *  1. `bind` only. Never `permit`, never `commit`. If pressure could harden a
 *     grant, an attacker would generate refusals deliberately to lock a rival's
 *     grant shut — a remote-controlled lock anyone can throw.
 *  2. It can never exceed the top authority. A determination must always be
 *     reachable by somebody who owns the account. A control no human can
 *     override is not a safety feature, it is an outage.
 *  3. Every tightening is an event an operator can see and reverse. The
 *     hardening is recorded, not silent.
 *  4. It decays. Pressure is counted in a rolling window, so a seal fought over
 *     last quarter is not still hardened today on the strength of history.
 */
/**
 * WHICH BARS PRESSURE MAY RAISE, AND WHICH IT MUST NOT.
 *
 * Pressure is incremented by whoever presents a subject's aliases and is
 * refused — so a third party who knows an identifier can probe on that
 * person's behalf and harden their determination against them.
 *
 * That gives a rule for which axes hardening may touch: **only the bars a
 * legitimate party can clear by acting.** Authority can be cleared by finding
 * a higher authority. An evidence floor can be cleared by producing better
 * evidence. Both are answerable.
 *
 * Cooling-off and quorum are not. Time cannot be routed around at all, and a
 * second human cannot be produced by the person seeking relief. Raising either
 * under pressure would hand a third party a way to make somebody else's
 * refusal harder to lift, which is the opposite of what hardening is for.
 * Jurisdiction is likewise carried through unchanged — moving it would loosen
 * the rule, and dropping it certainly would.
 *
 * So `harden` spreads `...base` and overrides exactly two fields. If a new
 * axis is added to ClawRule, decide which side of this line it falls on before
 * adding it here.
 */
export function harden(
  disposition: 'bind' | 'permit' | 'commit',
  base: ClawRule,
  tier: PressureTier,
): { rule: ClawRule; hardened: boolean } {
  if (disposition !== 'bind' || tier === 'none') return { rule: base, hardened: false };

  const bumpAuthority = (a: Authority, by: number): Authority => {
    const next = Math.min(rankOf(a) + by, AUTHORITIES.length - 1);
    return AUTHORITIES[next] as Authority;
  };
  const raiseFloor = (f: Admissibility, to: Admissibility): Admissibility =>
    (dominates(f, to) ? f : to);

  let rule: ClawRule;
  switch (tier) {
    case 'persistent':
      // Visible, not yet harder. Persistence alone is not an attack, and
      // treating it as one punishes people for caring about the outcome.
      rule = base;
      break;
    case 'probing':
      rule = {
        ...base,
        authority: bumpAuthority(base.authority, 1),
        evidenceFloor: raiseFloor(base.evidenceFloor, 'receipt'),
      };
      break;
    case 'sustained':
      rule = {
        ...base,
        authority: bumpAuthority(base.authority, 2),
        evidenceFloor: raiseFloor(base.evidenceFloor, 'receipt'),
      };
      break;
  }

  const hardened = rule.authority !== base.authority
    || rule.evidenceFloor !== base.evidenceFloor
    || rule.coolingOffSeconds !== base.coolingOffSeconds;
  return { rule, hardened };
}
