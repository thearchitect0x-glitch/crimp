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
import { reevaluate, markFactExpiryDue, type Reevaluation } from '../domain/seal.js';
import { advanceClocks, resolveMissed } from '../domain/clocks.js';
import { propagateAdjudications, workspacesWithPendingReversals } from '../domain/systemic.js';
import { probingBreadth } from '../domain/breadth.js';
import { PRESSURE_WINDOW_DAYS } from '../domain/lifecycle.js';
import { recordDrift, DRIFT } from '../domain/drift.js';

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
  /** cap-09. Drift findings newly recorded this pass. */
  drift: number;
  /** Breadth findings recorded this pass: one session refused across many determinations. */
  breadth: number;
}

/**
 * A drift check is a fortnight of daily rates per rule; once an hour per
 * workspace is plenty, and a finding is deduplicated per window anyway. Per
 * replica, which is fine: the dedupe is in the database.
 */
const lastDriftCheck = new Map<string, number>();
const DRIFT_EVERY_MS = 3600e3;

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
  /** Run the drift check regardless of when it last ran. Tests, mostly. */
  forceDrift?: boolean;
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

  // The third trigger, before anything decides who has due work: a fact
  // that ran out under a standing determination makes it due, in every
  // workspace, with no write having happened.
  await markFactExpiryDue(pool);

  // Only workspaces that actually have due work. A deployment with ten
  // thousand idle tenants should not pay for them on every pass.
  const { rows: due } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM seals
      WHERE state IN ('sealed', 'tainted')
        AND (evaluation_due
             OR last_evaluated_at IS NULL
             OR (expires_at IS NOT NULL AND expires_at <= now()))`);

  const out: PassResult = { workspaces: due.length, examined: 0, changes: [], backlogged: 0,
    clocks: { met: 0, missed: 0 }, systemic, drift: 0, breadth: 0 };

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

  // The evaluation log is a fortnight of rates, not a history. Rows older
  // than the baseline plus a margin are read by nothing and are pruned here,
  // so the table stays the size of the question it answers.
  await pool.query(`DELETE FROM evaluation_log WHERE occurred_at < now() - ($1 || ' days')::interval`,
    [String(DRIFT.baselineDays + 7)]);
  // Pressure and session activity are read only within the window; rows
  // older than twice it are read by nothing. Found by the ten-year review:
  // the second unbounded table, after the evaluation log.
  await pool.query(`DELETE FROM pressure WHERE last_at < now() - ($1 || ' days')::interval`,
    [String(2 * PRESSURE_WINDOW_DAYS)]);
  await pool.query(`DELETE FROM session_activity WHERE day < current_date - ($1 || ' days')::interval`,
    [String(2 * PRESSURE_WINDOW_DAYS)]);

  // Drift: only workspaces that evaluated anything in the current window,
  // and not more than once an hour each.
  const { rows: active } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM evaluation_log
      WHERE occurred_at > now() - ($1 || ' hours')::interval`, [String(DRIFT.windowHours)]);
  for (const { workspace_id: ws } of active) {
    const last = lastDriftCheck.get(ws) ?? 0;
    if (!opts.forceDrift && Date.now() - last < DRIFT_EVERY_MS) continue;
    lastDriftCheck.set(ws, Date.now());
    out.drift += (await recordDrift(ws)).length;
  }
  // Breadth: one session, many people. A finding about the session.
  out.breadth = await probingBreadth(pool);

  return out;
}
