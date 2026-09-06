// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * A workspace's declared alias types and how much identity evidence each
 * carries.
 *
 * Read on every request that touches a subject. That is one small indexed
 * query, and it is deliberately not cached: merge strength decides whether an
 * identifier may permanently union two people, and a stale cache would apply
 * yesterday's classification to today's merge. If this ever shows up in a
 * profile, cache it with explicit invalidation — never with a TTL, because a
 * TTL means "wrong for up to N seconds" and the wrong answer here is not
 * recoverable.
 */
import { getPool, type Db } from '../db/pool.js';
import type { MergeStrength } from '../lib/blind.js';

export async function loadStrengths(
  workspaceId: string, db: Db = getPool(),
): Promise<Record<string, MergeStrength>> {
  const { rows } = await db.query<{ alias_type: string; merge_strength: MergeStrength }>(
    'SELECT alias_type, merge_strength FROM alias_types WHERE workspace_id = $1',
    [workspaceId]);
  const out: Record<string, MergeStrength> = {};
  for (const r of rows) out[r.alias_type] = r.merge_strength;
  return out;
}

export async function declareAliasType(
  workspaceId: string, aliasType: string, strength: MergeStrength, db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO alias_types (workspace_id, alias_type, merge_strength) VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, alias_type) DO UPDATE SET merge_strength = EXCLUDED.merge_strength`,
    [workspaceId, aliasType, strength]);
}
