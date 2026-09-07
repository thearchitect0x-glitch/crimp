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
  /**
   * How many DISTINCT credentials must sign to reverse. 1 or 2.
   *
   * Four-eyes, for an act that is consequential and hard to undo. Two
   * signatures from the same key is one signature typed twice, so the second
   * must come from a different key, and both clear every other bar
   * independently — a quorum lowers nothing.
   */
  quorum?: 1 | 2;
  /**
   * Where the reversing credential must be bound. Null means anywhere.
   *
   * Authority here is a property of the credential and unforgeable by the
   * caller, so this turns "every reversal affecting a person in this
   * jurisdiction was performed under authority bound to it" from a contractual
   * promise into a refusal in code.
   */
  jurisdiction?: string | null;
}

/**
 * How long the first half of a quorum stands.
 *
 * A dual-control decision that takes longer than this is not one decision made
 * by two people, it is two unrelated decisions. It also bounds the attacker
 * who holds one credential now and expects to hold another later.
 */
export const QUORUM_WINDOW_SECONDS = 7 * 24 * 3600;

const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

/** A day is the default ceiling on how far an agent may put a seal out of reach. */
export const MAX_COOLING_OFF_SECONDS = 90 * 24 * 3600;

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
export function validateClawRule(
  sealedBy: Authority, claw: ClawRule, sealerJurisdiction: string | null = null,
): ClawRule {
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
  if (claw.coolingOffSeconds > MAX_COOLING_OFF_SECONDS) {
    throw new ApiError(400, 'invalid_claw_rule',
      `Cooling-off may be at most ${MAX_COOLING_OFF_SECONDS} seconds.`,
      { limit: MAX_COOLING_OFF_SECONDS });
  }

  // A sealer may demand only the place its OWN credential is bound to.
  // An arbitrary string would hand back the denial-of-service the authority
  // ladder exists to prevent, on a third axis: name a jurisdiction no key
  // holds and the determination can never be lifted by anyone.
  if (claw.jurisdiction != null && claw.jurisdiction !== sealerJurisdiction) {
    throw new ApiError(400, 'invalid_claw_rule',
      sealerJurisdiction === null
        ? 'This key is not bound to a jurisdiction, so it cannot require one of its reverser. '
          + 'A rule naming a place no credential holds is a determination nobody can lift.'
        : `A key bound to "${sealerJurisdiction}" may require reversal from there, not from `
          + `"${claw.jurisdiction}".`,
      { sealer: sealerJurisdiction, requested: claw.jurisdiction });
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
  if ((to.quorum ?? 1) < (from.quorum ?? 1)) {
    loosened.push(`quorum ${from.quorum ?? 1} → ${to.quorum ?? 1}`);
  }
  // Dropping a jurisdiction requirement, or swapping it for a different one,
  // both admit a reverser the original rule excluded.
  if (from.jurisdiction != null && to.jurisdiction !== from.jurisdiction) {
    loosened.push(`jurisdiction ${from.jurisdiction} → ${to.jurisdiction ?? 'any'}`);
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
