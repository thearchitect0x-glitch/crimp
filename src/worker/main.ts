// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The correction channel, running.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS PROCESS MUST BE LONG-RUNNING. It is not optional infrastructure.
 *
 * Everything this product claims that nothing else does depends on it. A
 * determination lapses when the rule that produced it stops holding — no
 * appeal, no authority, nobody having won an argument. That is the only error
 * signal in existence that does not require the affected person to have the
 * resources to fight, and roughly nine in ten Medicaid denials are never
 * appealed, so it is also the only one that sees them.
 *
 * Without this process, `reevaluate()` is a function nobody calls. Every
 * determination stands until a human intervenes, which is precisely the system
 * this was built to replace.
 *
 * It is also a condition of enhanced federal funding. 42 CFR 433.112(b)(15)
 * and 433.116 require a state to produce evidence that outcomes are met "on an
 * ongoing basis", and there is no reading of ongoing that a system nobody
 * schedules can satisfy.
 *
 * A serverless function cannot do this. Expiry is time-driven — nothing is
 * attested when a determination simply runs out — so there is no request to
 * hang the work off. Multiple replicas are safe: every state change is a
 * compare-and-set against the state the sweep observed, so a race loses
 * cleanly rather than double-applying.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { closePool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { sweepOnce } from './sweep.js';

const INTERVAL_MS = Number(process.env['SWEEP_INTERVAL_MS'] ?? 60_000);
const BATCH = Number(process.env['SWEEP_BATCH'] ?? 200);
const MAX_BATCHES = Number(process.env['SWEEP_MAX_BATCHES'] ?? 5);

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', at: new Date().toISOString(), msg, ...extra }));
}

let stopping = false;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function loop(): Promise<void> {
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await sweepOnce({ batchSize: BATCH, maxBatchesPerWorkspace: MAX_BATCHES });
      if (r.examined > 0 || r.changes.length > 0) {
        log('sweep', {
          workspaces: r.workspaces, examined: r.examined,
          changed: r.changes.length, backlogged: r.backlogged,
          ms: Date.now() - started,
          // Counted by kind, never by seal id: a log line naming which
          // determinations lapsed is a disclosure with no access control on it.
          kinds: r.changes.reduce<Record<string, number>>((a, c) => {
            a[c.to] = (a[c.to] ?? 0) + 1; return a;
          }, {}),
        });
      }
      // A backlogged pass loops again at once. Sleeping through a queue of
      // people who are wrongly refused is the one thing this must not do.
      if (r.backlogged > 0 && !stopping) continue;
    } catch (err) {
      // Never exit on a sweep failure. A crashed worker is an uncorrected
      // population, and the next pass is a minute away.
      console.error(JSON.stringify({ level: 'error', msg: 'sweep failed',
        err: (err as Error).message }));
    }
    if (!stopping) await sleep(INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  // The API migrates on boot too, behind an advisory lock, so both may start
  // at once. This exists so the worker can run alone.
  if (process.env['MIGRATE_ON_BOOT'] !== 'false') await migrate(() => {});
  log('worker started', { intervalMs: INTERVAL_MS, batch: BATCH, maxBatches: MAX_BATCHES });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      log('worker stopping', { signal: sig });
    });
  }

  await loop();
  await closePool();
  log('worker stopped');
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'worker died', err: (err as Error).message }));
  process.exitCode = 1;
});
