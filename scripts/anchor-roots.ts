// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Anchor every unanchored global transparency root to the OpenTimestamps
 * calendars, and record the proofs on the root, once.
 *
 *   npx tsx scripts/anchor-roots.ts            # anchor what is pending
 *   npx tsx scripts/anchor-roots.ts --dry-run  # say what would be anchored
 *
 * Run daily, after 00:10 UTC, from wherever the database is reachable. It
 * is deliberately not part of the worker: the worker makes no outbound
 * calls, and anchoring is a decision an operator makes. The proofs are
 * pending until the calendars commit to Bitcoin (hours); complete them
 * with the reference client: save a proof as `<day>.ots` and run
 * `ots upgrade <day>.ots`. `ots info` reads any of them as written.
 */
import { getPool, closePool } from '../src/db/pool.js';
import { anchorRoot } from '../src/domain/transparency.js';
import { CALENDARS, detachedTimestamp, submitDigest } from '../src/lib/ots.js';

const dryRun = process.argv.includes('--dry-run');
const pool = getPool();
const { rows } = await pool.query<{ day: string; root: string; workspaces: number }>(
  `SELECT day::text AS day, root, workspaces FROM transparency_global_roots WHERE anchor IS NULL ORDER BY day`);
if (rows.length === 0) console.log('nothing to anchor');
for (const r of rows) {
  if (dryRun) { console.log(`would anchor ${r.day} ${r.root} (${r.workspaces} workspace root(s))`); continue; }
  const proofs: Array<{ calendar: string; ots_base64: string }> = [];
  for (const calendar of CALENDARS) {
    try {
      const ts = await submitDigest(calendar, r.root);
      proofs.push({ calendar, ots_base64: detachedTimestamp(r.root, ts).toString('base64') });
    } catch (e) {
      console.error(`${r.day}: ${calendar} refused: ${(e as Error).message}`);
    }
  }
  if (proofs.length === 0) { console.error(`${r.day}: no calendar took it; not recorded`); continue; }
  const recorded = await anchorRoot(pool, r.day, {
    kind: 'opentimestamps', digest: r.root, submitted_at: new Date().toISOString(), proofs,
    note: 'pending until the calendars commit to Bitcoin; complete with `ots upgrade` on any proof',
  });
  console.log(`${r.day} ${r.root.slice(0, 16)}… anchored with ${proofs.length} calendar(s)${recorded ? '' : ' (already anchored; not replaced)'}`);
}
await closePool();
