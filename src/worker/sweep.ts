// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * One pass of the correction channel, across every workspace.
 *
 * Separated from the loop that schedules it so it can be called directly from
 * a test, from a one-shot script, or from a platform's own scheduler — and so
 * the loop has nothing in it worth testing.
 */
import { getPool } from '../db/pool.js';
import { reevaluate, type Reevaluation } from '../domain/seal.js';
import { advanceClocks, resolveMissed } from '../domain/clocks.js';
import { propagateAdjudications, workspacesWithPendingReversals } from '../domain/systemic.js';

export interface PassResult {
  workspaces: number;
  examined: number;
  changes: Reevaluation[];
  /** Workspaces still holding due work when the pass ended. */
  backlogged: number;
  /** cap-03. Clocks that were met, and clocks that were found missed, this pass. */
  clocks: { met: number; missed: number };
  /** cap-06. Rulings propagated, and determinations placed under review, this pass. */
  systemic: { reviews: number; flagged: number };
}

/**
 * A pass is bounded, and that is deliberate.
 *
 * `maxBatchesPerWorkspace` stops one enormous workspace starving every other
 * one: a tenant with four million open determinations gets the same number of
 * batches per pass as a tenant with four, and its backlog is carried to the
 * next pass rather than held inside this one. Fairness beats throughput here,
 * because the thing being delayed is somebody finding out they were refused
 * for a reason that has since stopped being true.
 */
export async function sweepOnce(opts: {
  batchSize?: number;
  maxBatchesPerWorkspace?: number;
} = {}): Promise<PassResult> {
  const batchSize = opts.batchSize ?? 200;
  const maxBatches = opts.maxBatchesPerWorkspace ?? 5;
  const pool = getPool();

  // Rulings first: a determination placed under review is marked due, and
  // this pass should be the one that re-examines it.
  const systemic = { reviews: 0, flagged: 0 };
  for (const ws of await workspacesWithPendingReversals(pool)) {
    const r = await propagateAdjudications(ws);
    systemic.reviews += r.reviews.length;
    systemic.flagged += r.flagged;
  }

  // Only workspaces that actually have due work. A deployment with ten
  // thousand idle tenants should not pay for them on every pass.
  const { rows: due } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM seals
      WHERE state IN ('sealed', 'tainted')
        AND (evaluation_due
             OR last_evaluated_at IS NULL
             OR (expires_at IS NOT NULL AND expires_at <= now()))`);

  const out: PassResult = { workspaces: due.length, examined: 0, changes: [], backlogged: 0,
    clocks: { met: 0, missed: 0 }, systemic };

  for (const { workspace_id: ws } of due) {
    let remaining = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const r = await reevaluate(ws, batchSize);
      out.examined += r.examined;
      out.changes.push(...r.changes);
      remaining = r.remaining;
      if (r.examined === 0 || remaining === 0) break;
    }
    if (remaining > 0) out.backlogged++;
  }

  // Clocks tick whether or not any determination is due. A programme that
  // sealed nothing this week still owes somebody a decision by Friday.
  const { rows: ticking } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM clocks
      WHERE status = 'running' OR (status = 'missed' AND resolved_at IS NULL)`);
  for (const { workspace_id: ws } of ticking) {
    const a = await advanceClocks(ws);
    out.clocks.met += a.met;
    out.clocks.missed += a.missed;
    await resolveMissed(ws);
  }
  return out;
}
