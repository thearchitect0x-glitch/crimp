// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Mint the first key for a workspace, creating the workspace if needed.
 *
 * There is no signup endpoint, and this is deliberately a script rather than a
 * route: the first key of a workspace is the one thing that cannot be
 * authorised by an existing key, so exposing it over HTTP would mean exposing
 * an unauthenticated key-minting endpoint. A script requires database access,
 * which is a boundary that already exists.
 */
import { getPool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { mintKey, SCOPES, AGENT_SCOPES, type Scope } from '../src/domain/auth.js';
import { newId } from '../src/lib/ids.js';
import { AUTHORITIES, isAuthority } from '../src/domain/authority.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return v;
}

async function main(): Promise<void> {
  await migrate(() => {});
  const pool = getPool();

  const authority = arg('authority', 'operator');
  if (!isAuthority(authority)) {
    throw new Error(`--authority must be one of: ${AUTHORITIES.join(', ')}`);
  }
  const label = arg('label', 'first key');
  const narrow = process.argv.includes('--agent-scopes');

  let workspaceId = process.argv.includes('--workspace') ? arg('workspace') : '';
  if (workspaceId === '') {
    workspaceId = newId('ws');
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1,$2)',
      [workspaceId, arg('name', 'default')]);
    // A workspace with no declared sources and no declared alias types can
    // attest nothing, so seed the shape rather than leaving a dead workspace.
    await pool.query(
      `INSERT INTO fact_sources (workspace_id, source, admissibility) VALUES
         ($1,'agent_report','self'), ($1,'core_ledger','internal'),
         ($1,'carrier_api','receipt'), ($1,'state_registry','authority')`, [workspaceId]);
    await pool.query(
      `INSERT INTO alias_types (workspace_id, alias_type, merge_strength) VALUES
         ($1,'card_fp','strong'), ($1,'gov_id','strong'),
         ($1,'email','medium'), ($1,'device','weak')`, [workspaceId]);
    console.log(`created workspace ${workspaceId}`);
  }

  const key = await mintKey({
    workspaceId, authority,
    scopes: (narrow ? AGENT_SCOPES : SCOPES) as Scope[],
    label, by: null,
  });

  console.log(`\nworkspace : ${workspaceId}`);
  console.log(`authority : ${key.authority}`);
  console.log(`scopes    : ${key.scopes.join(', ')}`);
  console.log(`\n  export CRIMP_KEY=${key.key}\n`);
  console.log('This is the only time the key is shown. There is no endpoint that can print it again.');
}

main()
  .catch((err: unknown) => { console.error(String(err)); process.exitCode = 1; })
  .finally(() => closePool());
