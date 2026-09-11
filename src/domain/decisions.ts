// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-10 · A caseworker's decision, through the same gate as an agent's.
 *
 * The person at the keyboard names a committed rule and attaches facts. That
 * is all. The evaluator derives the disposition; the rule fixes what KIND of
 * determination it is; every fact is attested under the caseworker's own
 * credential; the seal, the reasons, the remedy, the notice and the record
 * are exactly what an agent's decision would produce. There is no field in
 * which an outcome could be typed, and no disposition parameter, because
 * "disposition" chosen at the keyboard would be an outcome field wearing a
 * hat.
 *
 * WHY THIS IS NOT JUST `attest` THEN `seal`. It is — in one transaction of
 * intent, with three things enforced that the two calls separately leave to
 * discipline: the actor must be a person (operator or above), the rule must
 * be committed and must carry its disposition, and the facts and the
 * determination are recorded as one act by one credential. A human who
 * wants to decide something the committed policy does not express has to
 * commit the policy first, on the record.
 */
import { ApiError } from '../lib/errors.js';
import type { MergeStrength } from '../lib/blind.js';
import { rankOf } from './authority.js';
import { requireScope, type Principal } from './auth.js';
import { attest, type AttestInput } from './attest.js';
import { seal, type SealResult } from './seal.js';
import { resolveRule } from './registry.js';
import { getPool } from '../db/pool.js';
import type { ClawRule } from './authority.js';

/** A decision is a person's act. Agents have the agent path. */
export const DECISION_AUTHORITY = 'operator';

/**
 * The claw rule a caseworker's determination carries unless one is given.
 * A person sealed it, so only a higher person may overrule it: principal,
 * on internal evidence, with no cooling-off — an operational default, not
 * a legal parameter, and any tighter rule may be passed.
 */
export const DEFAULT_CLAW: ClawRule = { authority: 'principal', evidenceFloor: 'internal', coolingOffSeconds: 0 };

export interface DecisionInput {
  idempotencyKey: string;
  aliases: unknown;
  scope: string;
  ruleset: string;
  ruleId: string;
  /** Every fact the caseworker asserts, each with its source. Attested under their credential. */
  facts: readonly AttestInput[];
  asOf?: Date | null;
  claw?: ClawRule | null;
  expiresAt?: Date | null;
}

export async function decide(
  p: Principal, input: DecisionInput, strengths: Readonly<Record<string, MergeStrength>>,
): Promise<SealResult & { attested: number; attester: string }> {
  requireScope(p, 'seals:write');
  requireScope(p, 'attestations:write');
  if (rankOf(p.authority) < rankOf(DECISION_AUTHORITY)) {
    throw new ApiError(403, 'insufficient_authority',
      `A decision is a person's act and requires ${DECISION_AUTHORITY} authority; this key is `
      + `${p.authority}. An agent seals through /seals, under the same rules.`,
      { required: DECISION_AUTHORITY, held: p.authority });
  }
  const asOf = input.asOf ?? null;
  const rule = await resolveRule(getPool(), p.workspaceId, input.ruleset, input.ruleId, asOf ?? new Date());
  if (rule.disposition === null) {
    throw new ApiError(409, 'rule_has_no_disposition',
      `Rule "${input.ruleId}" does not say what kind of determination it makes. A caseworker may not `
      + 'choose that at the keyboard: commit the rule with a disposition first.',
      { ruleset: input.ruleset, ruleId: input.ruleId });
  }

  // The facts, under the caseworker's own credential — `attest` records the
  // key id as attester on every row. A decision with no facts to attach is
  // allowed: the facts may already be on file, and the rule will say so.
  let attested = 0;
  if (input.facts.length > 0) {
    attested = (await attest(p, { aliases: input.aliases, facts: input.facts }, strengths)).count;
  }

  const out = await seal(p, {
    idempotencyKey: input.idempotencyKey,
    aliases: input.aliases,
    scope: input.scope,
    disposition: rule.disposition,
    ruleRef: { ruleset: input.ruleset, ruleId: input.ruleId },
    asOf,
    claw: input.claw ?? DEFAULT_CLAW,
    expiresAt: input.expiresAt ?? null,
  }, strengths);
  return { ...out, attested, attester: p.keyId };
}
