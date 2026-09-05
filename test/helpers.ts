// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { getPool } from '../src/db/pool.js';
import { newId } from '../src/lib/ids.js';
import { mintKey, verifyKey, SCOPES, type Principal } from '../src/domain/auth.js';
import type { MergeStrength } from '../src/lib/blind.js';
import type { Authority } from '../src/domain/authority.js';

export const STRENGTHS: Record<string, MergeStrength> = {
  card_fp: 'strong',
  gov_id: 'strong',
  email: 'medium',
  device: 'weak',
};

/** A workspace with its sources declared, isolated from every other test. */
export async function freshWorkspace(): Promise<string> {
  const id = newId('ws');
  const pool = getPool();
  await pool.query('INSERT INTO workspaces (id, name) VALUES ($1,$2)', [id, `test ${id}`]);
  await pool.query(
    `INSERT INTO fact_sources (workspace_id, source, admissibility) VALUES
       ($1,'agent_report','self'),
       ($1,'core_ledger','internal'),
       ($1,'carrier_api','receipt'),
       ($1,'state_registry','authority')`,
    [id]);
  return id;
}

/**
 * Real minted keys, verified through the real path.
 *
 * Tests hold principals rather than fabricating them, so every assertion below
 * is also an assertion that authority survives the round trip through
 * mint → present → verify. A test that constructs its own Principal would
 * prove the domain works while saying nothing about whether authority can be
 * forged, which is the question that matters.
 */
export interface Actors {
  ws: string;
  agent: Principal;
  operator: Principal;
  principal: Principal;
  custodian: Principal;
}

export async function actors(): Promise<Actors> {
  const ws = await freshWorkspace();
  const made: Record<string, Principal> = {};
  for (const level of ['custodian', 'principal', 'operator', 'agent'] as Authority[]) {
    const k = await mintKey({
      workspaceId: ws, authority: level, scopes: [...SCOPES], label: level, by: null,
    });
    made[level] = await verifyKey(k.key);
  }
  return {
    ws,
    agent: made['agent']!,
    operator: made['operator']!,
    principal: made['principal']!,
    custodian: made['custodian']!,
  };
}

export const person = (tag: string) => [
  { type: 'card_fp', value: `card-${tag}` },
  { type: 'email', value: `${tag}@example.com` },
];

export async function countEvents(sealId: string, kind: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*) AS n FROM seal_events WHERE seal_id = $1 AND kind = $2', [sealId, kind]);
  return Number(rows[0]?.n ?? 0);
}

export async function stateOf(sealId: string): Promise<string | undefined> {
  const { rows } = await getPool().query<{ state: string }>(
    'SELECT state FROM seals WHERE id = $1', [sealId]);
  return rows[0]?.state;
}

/** Push a seal's sealed_at backwards so a cooling-off window can be tested without waiting. */
export async function ageSeal(sealId: string, seconds: number): Promise<void> {
  await getPool().query(
    `UPDATE seals SET sealed_at = sealed_at - ($2 || ' seconds')::interval WHERE id = $1`,
    [sealId, String(seconds)]);
}

export const hash64 = (s: string): string =>
  [...s].reduce((a, c) => a + c.charCodeAt(0), 0).toString(16).padStart(64, 'a').slice(0, 64);
