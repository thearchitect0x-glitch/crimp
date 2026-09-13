// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * An appeal, on the record of the determination it contests.
 *
 * Found by the prior-authorization configuration. Pressure (lifecycle.ts)
 * sees a person coming back and being refused again; in prior
 * authorization nobody comes back that way. The member never looks up
 * the determination; the provider's portal session touches many members
 * and is, correctly, excluded as wide. Resistance there arrives as an
 * APPEAL — a reconsideration, a grievance, an external review request —
 * and the quadrant (insight.ts) was blind to it. So an appeal is an event
 * on the determination, recorded by whoever received it, and the quadrant
 * and the estimate count a determination with an appeal as contested,
 * beside one with refused attempts.
 *
 * An appeal is not a ruling. The ruling, when it comes, is the
 * adjudication family (systemic.ts) and may reach every case under the
 * rule; the appeal reaches only this record, and changes nothing about
 * its state.
 */
import { withTx } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { requireScope, type Principal } from './auth.js';

export const APPEAL_CHANNELS = ['member', 'representative', 'provider', 'external_review', 'other'] as const;
export type AppealChannel = (typeof APPEAL_CHANNELS)[number];

export interface AppealInput {
  sealId: string;
  /** Who brought it: the person, someone acting for them, the provider, an external reviewer. */
  channel: AppealChannel;
  /** The institution's own reference for the appeal, if any. Opaque; never a subject identifier. */
  reference?: string | null;
  /** When it was filed, if not now. */
  filedAt?: Date | null;
}

export async function recordAppeal(p: Principal, args: AppealInput): Promise<{ sealId: string; filedAt: Date }> {
  requireScope(p, 'seals:write');
  if (!APPEAL_CHANNELS.includes(args.channel)) {
    throw new ApiError(400, 'invalid_request', `channel must be one of ${APPEAL_CHANNELS.join(', ')}.`);
  }
  if (args.reference !== undefined && args.reference !== null
      && (typeof args.reference !== 'string' || args.reference.length > 128)) {
    throw new ApiError(400, 'invalid_request', 'reference must be a string of at most 128 characters.');
  }
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ disposition: string }>(
      'SELECT disposition FROM seals WHERE workspace_id = $1 AND id = $2', [p.workspaceId, args.sealId]);
    const s = rows[0];
    if (s === undefined) throw new ApiError(404, 'not_found', 'No such determination.');
    if (s.disposition !== 'bind') {
      throw new ApiError(409, 'not_adverse', `An appeal contests a refusal; this determination is a ${s.disposition}.`);
    }
    const filedAt = args.filedAt ?? new Date();
    await tx.query(
      `INSERT INTO seal_events (seal_id, workspace_id, kind, actor, detail, occurred_at)
       VALUES ($1, $2, 'appealed', $3, $4::jsonb, $5)`,
      [args.sealId, p.workspaceId, p.authority,
        JSON.stringify({ channel: args.channel, reference: args.reference ?? null, key_id: p.keyId }), filedAt]);
    return { sealId: args.sealId, filedAt };
  });
}
