// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Who may reverse what, and the rule that a sealer chooses its own jailer.
 *
 * Authority is a TOTAL order, unlike admissibility. Admissibility describes
 * kinds of evidence, which are often incomparable; authority describes who
 * overrules whom, which is hierarchical by construction. Leaving "who wins"
 * undefined at the moment two authorities disagree would be the one place a
 * partial order is unaffordable.
 */
import { ApiError } from '../lib/errors.js';
import { ADMISSIBILITY, dominates, type Admissibility } from './admissibility.js';

export const AUTHORITIES = ['agent', 'operator', 'principal', 'custodian'] as const;
export type Authority = (typeof AUTHORITIES)[number];

const RANK: Record<Authority, number> = {
  agent: 0, operator: 1, principal: 2, custodian: 3,
};

export function rankOf(a: Authority): number { return RANK[a]; }
export function isAuthority(v: unknown): v is Authority {
  return typeof v === 'string' && (AUTHORITIES as readonly string[]).includes(v);
}

/** The declared, immutable-except-tighter procedure for reversing a seal. */
export interface ClawRule {
  authority: Authority;
  evidenceFloor: Admissibility;
  coolingOffSeconds: number;
}

/**
 * THE TIME AXIS, which the authority ladder never bounded.
 *
 * `validateClawRule` has always bounded WHO may reverse a determination: an
 * agent may require at most one level above itself, because "an agent that can
 * put determinations beyond an operator's reach is a denial-of-service weapon
 * pointed at its own workspace." That reasoning was written down, and it was
 * enforced on exactly one axis.
 *
 * Cooling-off had a single global ceiling of ninety days for every authority,
 * and a determination's duration had none at all — absent `expires_at` means
 * forever. So an agent holding nothing but `seals:write` could author a
 * refusal that never expires and that NOBODY, including a custodian, can lift
 * for three months. That is the identical weapon the ladder refuses, reached
 * along the axis nobody checked. (The comment above this constant used to say
 * "a day" while the constant said ninety; the ladder below is what it should
 * have said.)
 *
 * WHY THESE SHAPES. Cooling-off is the one defence immune to a perfectly
 * persuasive argument — you cannot talk time into passing — and the cost of it
 * falls entirely on the person still refused. So the authority that can impose
 * the longest wait should be the one accountable for the wait: an hour for an
 * automated process, ninety days only for the top of the ladder. Duration is
 * the same argument about permanence: an agent should not be able to author a
 * determination that outlives the quarter.
 *
 * The numbers are round because they are policy, not measurement, and a round
 * number is easier to argue with than a precise-looking one.
 */
export interface TimeBound {
  /** Longest reversal delay this authority may impose. */
  coolingOffSeconds: number;
  /** Longest a determination it seals may stand. `null` is unbounded. */
  maxDurationSeconds: number | null;
}

const DAY = 24 * 3600;

/**
 * `custodian` is present for type completeness and is UNREACHABLE through
 * `seal()`. The claw authority must strictly exceed the sealer, and nothing
 * exceeds the top of a total order, so a custodian cannot seal anything. That
 * is the no-self-reversal rule reaching its logical end rather than an
 * oversight: the highest authority governs the system, it does not decide
 * cases, because its determinations could never be reversed by anyone. Tested
 * in `claw-time.test.ts` so it stays a known property.
 */
export const TIME_BOUNDS: Record<Authority, TimeBound> = {
  agent: { coolingOffSeconds: 3600, maxDurationSeconds: 30 * DAY },
  operator: { coolingOffSeconds: 7 * DAY, maxDurationSeconds: 365 * DAY },
  principal: { coolingOffSeconds: 30 * DAY, maxDurationSeconds: 5 * 365 * DAY },
  custodian: { coolingOffSeconds: 90 * DAY, maxDurationSeconds: null },
};

/** The ceiling for the highest authority. Nothing may exceed it. */
export const MAX_COOLING_OFF_SECONDS = TIME_BOUNDS.custodian.coolingOffSeconds;

/**
 * Validate a claw rule against the authority that is sealing.
 *
 * Two invariants, and the second is the one that stops this product being a
 * weapon pointed at its owner.
 *
 * **No self-reversal.** The claw authority must strictly exceed the sealer. An
 * agent can seal a refusal it can never lift — the sentence the whole product
 * is sold on — and it holds for every level, not only agents.
 *
 * **Blast radius.** An `agent` may require at most ONE level above itself. A
 * compromised agent can still seal garbage, but the cleanup is an operator's
 * afternoon rather than a bricked business. Human authorities are not capped:
 * a principal choosing custodian-only reversal is an accountable person making
 * a deliberate, expensive choice, which is a different act from an automated
 * process doing it a million times before anyone notices.
 */
export function validateClawRule(sealedBy: Authority, claw: ClawRule): ClawRule {
  if (!isAuthority(claw.authority)) {
    throw new ApiError(400, 'invalid_claw_rule',
      `Claw authority must be one of: ${AUTHORITIES.join(', ')}.`);
  }
  if (!(ADMISSIBILITY as readonly string[]).includes(claw.evidenceFloor)) {
    throw new ApiError(400, 'invalid_claw_rule',
      `Evidence floor must be one of: ${ADMISSIBILITY.join(', ')}.`);
  }
  if (!Number.isSafeInteger(claw.coolingOffSeconds) || claw.coolingOffSeconds < 0) {
    throw new ApiError(400, 'invalid_claw_rule', 'Cooling-off must be a non-negative integer of seconds.');
  }
  const bound = TIME_BOUNDS[sealedBy];
  if (claw.coolingOffSeconds > bound.coolingOffSeconds) {
    throw new ApiError(400, 'invalid_claw_rule',
      `A "${sealedBy}" seal may impose at most ${bound.coolingOffSeconds} seconds of `
      + `cooling-off, not ${claw.coolingOffSeconds}. The wait falls entirely on the person `
      + 'still refused, so the authority that can impose the longest one is the authority '
      + 'accountable for it.',
      { sealedBy, limit: bound.coolingOffSeconds, requested: claw.coolingOffSeconds });
  }

  const sealer = RANK[sealedBy];
  const reverser = RANK[claw.authority];

  if (reverser <= sealer) {
    throw new ApiError(400, 'invalid_claw_rule',
      `A "${sealedBy}" seal cannot declare "${claw.authority}" as its reversing authority — the `
      + 'authority that may reverse must strictly exceed the authority that sealed. Otherwise the '
      + 'sealer can lift its own determination, which is the thing a seal is for.',
      { sealedBy, clawAuthority: claw.authority });
  }

  if (sealedBy === 'agent' && reverser > sealer + 1) {
    throw new ApiError(400, 'invalid_claw_rule',
      `An agent may require at most one authority level above itself ("operator"), not `
      + `"${claw.authority}". An agent that can put determinations beyond an operator's reach is `
      + 'a denial-of-service weapon pointed at its own workspace.',
      { sealedBy, clawAuthority: claw.authority, maximum: 'operator' });
  }

  return claw;
}

/**
 * May a claw rule be changed to this?
 *
 * Invariant II: tighten and never loosen. The rule was fixed before the sealer
 * knew whether it would want one, and that is the only reason it is worth
 * anything. Every dimension moves one way — authority up, evidence floor up,
 * cooling-off longer.
 */
export function assertTightening(from: ClawRule, to: ClawRule): void {
  const loosened: string[] = [];

  if (RANK[to.authority] < RANK[from.authority]) {
    loosened.push(`authority ${from.authority} → ${to.authority}`);
  }
  // `to` must still dominate `from`'s floor; anything else admits weaker evidence.
  if (!dominates(to.evidenceFloor, from.evidenceFloor)) {
    loosened.push(`evidence floor ${from.evidenceFloor} → ${to.evidenceFloor}`);
  }
  if (to.coolingOffSeconds < from.coolingOffSeconds) {
    loosened.push(`cooling-off ${from.coolingOffSeconds}s → ${to.coolingOffSeconds}s`);
  }

  if (loosened.length > 0) {
    throw new ApiError(409, 'claw_rule_loosened',
      `A claw rule may be tightened and never loosened. Refused: ${loosened.join('; ')}.`,
      { loosened });
  }
}

/** Does this authority satisfy the seal's declared reversal requirement? */
export function mayClaw(actor: Authority, required: Authority): boolean {
  return RANK[actor] >= RANK[required];
}
