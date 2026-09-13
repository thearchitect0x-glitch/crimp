// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The transparency anchor: a record's date, proven without its issuer's key.
 *
 * A signature says who issued a record. A verifier in 2038 may not trust a
 * 2026 key at all — it may have been broken, or leaked, or simply be one
 * the issuer no longer stands behind. What the verifier needs then is proof
 * that the record existed on the date it claims, from something the issuer
 * could not later change. So: every sealed core's digest is kept; once a
 * day the pass folds each workspace's day of digests into a Merkle root,
 * and the workspace roots into one global root; the global root is
 * published at a well-known address and can be anchored to a public
 * timestamp (OpenTimestamps, or any other). A record's inclusion proof is
 * the path from its core to the workspace root and from there to the
 * global root: two short lists of hashes that anyone can walk with
 * spec/verifier.mjs. Tenants are not disclosed by it — the global tree is
 * over roots, not over records, and the path names no workspace.
 *
 * Roots are computed for CLOSED days only (UTC), so a root, once made, is
 * final. Recomputing a closed day yields the same value; the pass is
 * idempotent.
 */
import { withTx, type Db } from '../db/pool.js';
import { root as merkleRoot, path as merklePath, type PathStep } from '../lib/merkle.js';

export const TRANSPARENCY_ALGORITHM = 'rfc6962-sha256/1';

export interface Inclusion {
  algorithm: typeof TRANSPARENCY_ALGORITHM;
  day: string;
  /** The record's own leaf: sha256 of the canonical sealed core. */
  leaf: string;
  workspace: { index: number; leaf_count: number; root: string; path: PathStep[] };
  global: { index: number; workspaces: number; root: string; path: PathStep[]; anchor: unknown | null } | null;
  /** Why `global` is null when it is: the day has not closed globally, or it closed and was anchored before this workspace's day was. */
  note: string | null;
}

/** The day's leaves for one workspace, in the fixed order the tree is built over. */
async function dayLeaves(db: Db, workspaceId: string, day: string): Promise<Array<{ id: string; core_sha256: string }>> {
  const { rows } = await db.query<{ id: string; core_sha256: string }>(
    `SELECT id, core_sha256 FROM seals
      WHERE workspace_id = $1 AND core_sha256 IS NOT NULL
        AND timezone('UTC', sealed_at)::date = $2::date
      ORDER BY sealed_at, id`, [workspaceId, day]);
  return rows;
}

/**
 * Compute and store the roots for every closed day that lacks one. A day is
 * closed when it is strictly before `closeBefore` (UTC date, default today),
 * so the set of cores under a root can no longer grow. Returns how many
 * workspace-days and global days were closed.
 */
export async function closeDays(db: Db, opts: { closeBefore?: string } = {}): Promise<{ workspaceDays: number; globalDays: number }> {
  const closeBefore = opts.closeBefore ?? new Date().toISOString().slice(0, 10);
  const { rows: pending } = await db.query<{ workspace_id: string; day: string }>(
    `SELECT DISTINCT s.workspace_id, timezone('UTC', s.sealed_at)::date::text AS day
       FROM seals s
      WHERE s.core_sha256 IS NOT NULL
        AND timezone('UTC', s.sealed_at)::date < $1::date
        AND NOT EXISTS (SELECT 1 FROM transparency_roots r
                         WHERE r.workspace_id = s.workspace_id AND r.day = timezone('UTC', s.sealed_at)::date)`,
    [closeBefore]);
  let workspaceDays = 0;
  for (const p of pending) {
    const leaves = await dayLeaves(db, p.workspace_id, p.day);
    const r = merkleRoot(leaves.map((l) => l.core_sha256));
    await db.query(
      `INSERT INTO transparency_roots (workspace_id, day, root, leaf_count) VALUES ($1, $2::date, $3, $4)
       ON CONFLICT (workspace_id, day) DO NOTHING`, [p.workspace_id, p.day, r, leaves.length]);
    workspaceDays++;
  }
  // Global roots for every closed day that has workspace roots and no global root,
  // or whose set of workspace roots grew since (a workspace closed late).
  const { rows: days } = await db.query<{ day: string; n: string }>(
    `WITH per_day AS (SELECT day, count(*) AS n FROM transparency_roots GROUP BY day)
     SELECT p.day::text AS day, p.n
       FROM per_day p LEFT JOIN transparency_global_roots g ON g.day = p.day
      WHERE g.day IS NULL OR g.workspaces <> p.n`);
  let globalDays = 0;
  for (const d of days) {
    const { rows: ws } = await db.query<{ root: string }>(
      'SELECT root FROM transparency_roots WHERE day = $1::date ORDER BY workspace_id', [d.day]);
    const g = merkleRoot(ws.map((w) => w.root));
    await withTx(async (tx) => {
      await tx.query(
        `INSERT INTO transparency_global_roots (day, root, workspaces) VALUES ($1::date, $2, $3)
         ON CONFLICT (day) DO UPDATE SET root = EXCLUDED.root, workspaces = EXCLUDED.workspaces, computed_at = now()
           WHERE transparency_global_roots.anchor IS NULL`, [d.day, g, ws.length]);
    });
    globalDays++;
  }
  return { workspaceDays, globalDays };
}

/** The inclusion proof for one record, or null when its day has not closed. */
export async function inclusionOf(db: Db, workspaceId: string, sealId: string): Promise<Inclusion | null> {
  const { rows } = await db.query<{ core_sha256: string | null; day: string }>(
    `SELECT core_sha256, timezone('UTC', sealed_at)::date::text AS day FROM seals WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, sealId]);
  const s = rows[0];
  if (s === undefined || s.core_sha256 === null) return null;
  const { rows: wr } = await db.query<{ root: string; leaf_count: number }>(
    'SELECT root, leaf_count FROM transparency_roots WHERE workspace_id = $1 AND day = $2::date', [workspaceId, s.day]);
  if (wr[0] === undefined) return null;
  const leaves = await dayLeaves(db, workspaceId, s.day);
  const index = leaves.findIndex((l) => l.id === sealId);
  if (index < 0) return null;
  const hexes = leaves.map((l) => l.core_sha256);
  const workspace = { index, leaf_count: leaves.length, root: wr[0].root, path: merklePath(hexes, index) };
  const { rows: gr } = await db.query<{ root: string; workspaces: number; anchor: unknown | null }>(
    'SELECT root, workspaces, anchor FROM transparency_global_roots WHERE day = $1::date', [s.day]);
  let global: Inclusion['global'] = null;
  let note: string | null = 'no global root for this day yet';
  if (gr[0] !== undefined) {
    const { rows: ws } = await db.query<{ workspace_id: string; root: string }>(
      'SELECT workspace_id, root FROM transparency_roots WHERE day = $1::date ORDER BY workspace_id', [s.day]);
    const gi = ws.findIndex((w) => w.workspace_id === workspaceId);
    if (gi >= 0 && ws.length === gr[0].workspaces) {
      global = { index: gi, workspaces: ws.length, root: gr[0].root, path: merklePath(ws.map((w) => w.root), gi), anchor: gr[0].anchor };
      note = null;
    } else {
      // The global root for this day was made — and anchored, or it would
      // have been recomputed — before this workspace's day closed. The
      // record reaches its workspace root and no further; say so rather
      // than "not yet".
      note = gr[0].anchor !== null
        ? `the global root for ${s.day} was anchored before this workspace's day closed; the proof reaches the workspace root only`
        : 'the global root for this day is being recomputed';
    }
  }
  return { algorithm: TRANSPARENCY_ALGORITHM, day: s.day, leaf: s.core_sha256, workspace, global, note };
}

export interface PublishedRoot { day: string; root: string; workspaces: number; computed_at: string; anchor: unknown | null }

/** The global roots, newest first. No authentication: this is what the world is meant to see. */
export async function publishedRoots(db: Db, limit = 400): Promise<PublishedRoot[]> {
  const { rows } = await db.query<{ day: string; root: string; workspaces: number; computed_at: Date; anchor: unknown | null }>(
    `SELECT day::text AS day, root, workspaces, computed_at, anchor FROM transparency_global_roots ORDER BY day DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({ day: r.day, root: r.root, workspaces: r.workspaces, computed_at: r.computed_at.toISOString(), anchor: r.anchor }));
}

/** Record an anchor for a day's global root, made by whatever the operator trusts. Refuses to replace one. */
export async function anchorRoot(db: Db, day: string, anchor: Record<string, unknown>): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE transparency_global_roots SET anchor = $2::jsonb WHERE day = $1::date AND anchor IS NULL`,
    [day, JSON.stringify(anchor)]);
  return (rowCount ?? 0) === 1;
}
