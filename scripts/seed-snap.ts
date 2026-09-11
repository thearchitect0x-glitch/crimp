// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * A SNAP workspace, ready to seal against: the FY 2026 programme
 * configuration in src/programmes/snap.ts applied to a fresh workspace,
 * with one operator key.
 *
 *   npx tsx scripts/seed-snap.ts [--name "SNAP demo"] [--workspace ws_…]
 *
 * Idempotent on an existing workspace. Like scripts/mint.ts, the key is
 * printed once and never again; it goes in your shell, not in a chat.
 */
import { getPool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { mintKey, verifyKey, SCOPES, type Scope } from '../src/domain/auth.js';
import { newId } from '../src/lib/ids.js';
import { seedSnap } from '../src/programmes/snap.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || process.argv[i + 1] === undefined ? fallback : process.argv[i + 1]!;
}

async function main(): Promise<void> {
  await migrate(() => {});
  const pool = getPool();
  let workspaceId = arg('workspace', '');
  if (workspaceId === '') {
    workspaceId = newId('ws');
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1,$2)', [workspaceId, arg('name', 'SNAP demo')]);
    console.log(`created workspace ${workspaceId}`);
  }
  const minted = await mintKey({ workspaceId, authority: 'operator', scopes: SCOPES as unknown as Scope[],
    label: 'snap seed operator', by: null });
  const p = await verifyKey(minted.key);
  const out = await seedSnap(p);
  console.log(`sources ${out.sources} · facts ${out.facts} · rules committed ${out.committed}, already ${out.alreadyCommitted}`);
  for (const r of out.rules) console.log(`  ${r.ruleId.padEnd(26)} ${r.disposition ?? '-'}  ${r.legalAuthority}`);
  console.log(`\nworkspace : ${workspaceId}\n\n  export CRIMP_KEY=${minted.key}\n`);
  console.log('This is the only time the key is shown.');
}

main()
  .catch((err: unknown) => { console.error(String(err)); process.exitCode = 1; })
  .finally(() => closePool());
