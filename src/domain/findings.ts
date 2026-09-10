// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Findings: what the system noticed, addressed to the institution.
 *
 * A finding never changes an outcome. That is enforced by absence: nothing in
 * `seal.ts`, `evaluate.ts` or the sweep reads this table. It is the channel
 * through which the measurement reaches the measured — a missed deadline, a
 * ruling that reaches other cases, a feed that went quiet — and it is kept
 * separate from the record about a person so that it can never be mistaken
 * for one. A finding has no subject id.
 */
import { getPool, type Db } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { requireScope, type Principal } from './auth.js';

export const FINDING_CLASSES = ['agency_timeliness', 'systemic_review', 'drift'] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];
export type FindingSubject = 'clock' | 'seal' | 'rule' | 'workspace';

export interface Finding {
  id: string;
  class: string;
  subjectKind: FindingSubject;
  subjectId: string;
  detail: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Record one. Returns null when the finding already exists — the partial
 * unique index makes a timeliness finding once-per-clock whatever two workers
 * do, and the caller learns which of them got there first.
 */
export async function recordFinding(db: Db, workspaceId: string, args: {
  class: FindingClass; subjectKind: FindingSubject; subjectId: string;
  detail: Record<string, unknown>;
}): Promise<Finding | null> {
  const id = newId('fnd');
  const { rows } = await db.query<{ occurred_at: Date }>(
    `INSERT INTO findings (id, workspace_id, class, subject_kind, subject_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING occurred_at`,
    [id, workspaceId, args.class, args.subjectKind, args.subjectId, JSON.stringify(args.detail)]);
  if (!rows[0]) return null;
  return { id, class: args.class, subjectKind: args.subjectKind, subjectId: args.subjectId,
    detail: args.detail, occurredAt: rows[0].occurred_at };
}

export async function listFindings(p: Principal, opts: {
  class?: string | undefined; days?: number;
}): Promise<Finding[]> {
  requireScope(p, 'insight:read');
  const { rows } = await getPool().query<{
    id: string; class: string; subject_kind: FindingSubject; subject_id: string;
    detail: Record<string, unknown>; occurred_at: Date;
  }>(
    `SELECT id, class, subject_kind, subject_id, detail, occurred_at
       FROM findings
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR class = $2)
        AND occurred_at > now() - ($3 || ' days')::interval
      ORDER BY occurred_at DESC LIMIT 500`,
    [p.workspaceId, opts.class ?? null, String(opts.days ?? 90)]);
  return rows.map((r) => ({ id: r.id, class: r.class, subjectKind: r.subject_kind,
    subjectId: r.subject_id, detail: r.detail, occurredAt: r.occurred_at }));
}
