// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Which person is this? — the one question the rest of the system assumes has
 * already been answered correctly.
 *
 * THE HOLE THIS CLOSES. `blind.ts` has said since the first commit that "only
 * STRONG aliases may cause a union; weak ones can carry a binding but never
 * create one", and shipped `mergeCapable()` to express it. Nothing called it.
 * Every write path resolved a subject from *any* presented alias and then
 * attached every other presented alias to whatever it found, which meant:
 *
 *     attest([card_of_attacker, shared_household_device])
 *
 * silently unioned the attacker with whoever else used that device — no
 * authority, no evidence, no merge call, from an ordinary agent key. The
 * poisoning merge the whole subject graph is shaped around was reachable
 * through the front door, and the explicit merge endpoint would have been a
 * bounded, audited, `principal`-gated version of something anybody could
 * already do for free.
 *
 * THE RULE. A write resolves identity from merge-capable aliases alone. Weak
 * ones ride along: they attach if they are free, they stay where they are if
 * they are not, and they never decide who this is. A read is different — a
 * weak alias must carry a binding, or a refusal is escaped by presenting a
 * different phone — so `resolveForRead` looks at everything.
 *
 * THE COST, STATED. A presentation whose strong alias is unknown creates a new
 * subject even when a weak alias would have found an existing one. That is
 * more subjects and more `merge_required` than before, and it is the safe
 * direction: an explicit merge is bounded, authorised and recorded, and an
 * implicit one is none of those.
 */
import pg from 'pg';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { mergeCapable, type BlindedAlias, type MergeStrength } from '../lib/blind.js';

const MERGE_ENDPOINT = 'POST /v1/subjects/merge';

export interface Resolved { subjectId: string; created: boolean }

function ambiguous(n: number, doing: string): ApiError {
  return new ApiError(409, 'merge_required',
    `These aliases already identify ${n} distinct subjects, so Crimp cannot tell which person `
    + `this is and will not guess before ${doing}. Unioning them is permanent and cannot be `
    + `undone, so it is not done implicitly: resolve it with ${MERGE_ENDPOINT}, which requires `
    + 'principal authority and evidence.', { subjects: n });
}

async function subjectsBehind(
  tx: pg.PoolClient, workspaceId: string, aliases: readonly BlindedAlias[],
): Promise<string[]> {
  if (aliases.length === 0) return [];
  const { rows } = await tx.query<{ subject_id: string }>(
    `SELECT DISTINCT subject_id FROM subject_aliases
      WHERE workspace_id = $1 AND (alias_type, blinded) IN (
        SELECT * FROM UNNEST($2::text[], $3::text[]))`,
    [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded)]);
  return rows.map((r) => r.subject_id);
}

/** The workspace's declared threshold for what may cause a union. */
export async function thresholdOf(
  tx: pg.PoolClient, workspaceId: string,
): Promise<MergeStrength> {
  const { rows } = await tx.query<{ merge_threshold: MergeStrength }>(
    'SELECT merge_threshold FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0]?.merge_threshold ?? 'strong';
}

/**
 * Resolve for a WRITE: attesting a fact, sealing a determination, placing a
 * cohort. Identity comes from merge-capable aliases only.
 */
export async function resolveForWrite(
  tx: pg.PoolClient, workspaceId: string, aliases: readonly BlindedAlias[],
  opts: { create?: boolean; doing?: string } = {},
): Promise<Resolved> {
  const doing = opts.doing ?? 'writing';
  const capable = mergeCapable(aliases, await thresholdOf(tx, workspaceId));

  // A presentation with no capable alias cannot union anybody, so it is safe to
  // let the weak ones locate the subject they are already attached to. What it
  // must not do is bring a strong alias along, and there is none to bring.
  const deciding = capable.length > 0 ? capable : aliases;
  const found = await subjectsBehind(tx, workspaceId, deciding);
  if (found.length > 1) throw ambiguous(found.length, doing);

  let subjectId = found[0];
  let created = false;
  if (subjectId === undefined) {
    if (opts.create === false) {
      throw new ApiError(404, 'unknown_subject',
        'No subject matches these aliases. Attest something about them first.');
    }
    subjectId = newId('sub');
    created = true;
    await tx.query('INSERT INTO subjects (id, workspace_id) VALUES ($1,$2)',
      [subjectId, workspaceId]);
  }

  // Attach everything presented. `DO NOTHING` is what keeps this safe: an alias
  // already bound to somebody else stays bound to them, so the shared device in
  // the presentation above never moves and never drags its owner along.
  //
  // A carved-out pair is skipped, or the next write silently undoes what an
  // authority deliberately separated.
  await tx.query(
    `INSERT INTO subject_aliases (workspace_id, alias_type, blinded, subject_id, merge_strength)
     SELECT $1, t, b, $4, s FROM UNNEST($2::text[], $3::text[], $5::text[]) AS u(t, b, s)
      WHERE NOT EXISTS (SELECT 1 FROM alias_carve_outs co
                         WHERE co.workspace_id = $1 AND co.alias_type = u.t
                           AND co.blinded = u.b AND co.subject_id = $4)
     ON CONFLICT (workspace_id, alias_type, blinded) DO NOTHING`,
    [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded), subjectId,
      aliases.map((a) => a.strength)]);
  await tx.query(
    `UPDATE subjects SET alias_count =
       (SELECT count(*) FROM subject_aliases WHERE subject_id = $1) WHERE id = $1`, [subjectId]);

  return { subjectId, created };
}

/**
 * Resolve for a READ: is this action bound?
 *
 * Every alias counts here, weak ones included. A determination that could be
 * escaped by presenting a different device would not be a determination, and
 * a read attaches nothing, so a shared identifier cannot union anybody through
 * this path. Returns null when nothing matches — an unknown subject is not
 * an error on the hot path, it is the common case.
 */
export async function resolveForRead(
  tx: pg.PoolClient, workspaceId: string, aliases: readonly BlindedAlias[],
): Promise<string | null> {
  const found = await subjectsBehind(tx, workspaceId, aliases);
  if (found.length > 1) throw ambiguous(found.length, 'answering');
  return found[0] ?? null;
}
