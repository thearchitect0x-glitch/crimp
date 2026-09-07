// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** One sweep, then exit. For cron, for a smoke test, for looking at the output. */
import { closePool } from '../src/db/pool.js';
import { sweepOnce } from '../src/worker/sweep.js';

const r = await sweepOnce();
console.log(JSON.stringify({
  workspaces: r.workspaces, examined: r.examined,
  changed: r.changes.length, backlogged: r.backlogged,
}, null, 2));
await closePool();
