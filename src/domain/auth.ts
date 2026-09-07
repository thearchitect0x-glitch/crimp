// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Keys, scopes, and where authority actually comes from.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: authority is a property of the
 * credential and is never accepted from a request. There is no parameter
 * anywhere in the API through which a caller states its own authority, because
 * every invariant in the product — an agent may not lift what it sealed, a claw
 * must exceed its sealer, an agent may not put a determination beyond an
 * operator — is worth exactly nothing if the caller gets to pick.
 *
 * Issuance follows the same ladder it enforces. A key mints only keys strictly
 * below itself, so an agent key mints nothing. Otherwise the ladder is
 * decorative: an agent mints an operator key, claws its own determination, and
 * invariant III is defeated by one level of indirection.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPool, type Db } from '../db/pool.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { AUTHORITIES, rankOf, isAuthority, type Authority } from './authority.js';

/** What a verified credential establishes. Nothing here comes from the request body. */
export interface Principal {
  workspaceId: string;
  keyId: string;
  authority: Authority;
  scopes: ReadonlySet<string>;
}

export const SCOPES = [
  'attestations:write',
  'seals:write',
  'determinations:read',
  'permits:exercise',
  'seals:claw',
  'insight:read',
  'keys:mint',
  // Deliberately absent from AGENT_SCOPES. Placing a person in a cohort is a
  // configuration act, and an agent that could do it could shape the very
  // measurement that exists to catch it.
  'cohorts:write',
  // Merge and its carve-out share one scope. A key that can union two people
  // and cannot separate them is worse than a key that can do neither. Also
  // absent from AGENT_SCOPES, and gated on `principal` on top of the scope:
  // a union is permanent, and permanence is not something a scope conveys.
  'subjects:merge',
  // Reading a determination back, and the higher bar for reading it back WITH
  // the values that decided it. Both absent from AGENT_SCOPES: `seal` already
  // returns the value-free reasons to whoever created the determination, and
  // an agent that could disclose thresholds could map every cliff in the
  // policy from inside the workspace it is supposed to be constrained by.
  'seals:read',
  'seals:disclose',
] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * The narrow set a quickstart should hand an agent.
 *
 * Ratchet learned this one the expensive way: the key its signup issued held
 * every scope, and a quickstart invited you to paste it into an agent — an
 * agent that could then rewrite the policy constraining it. The narrow key is
 * the default here from the first commit, not a later correction.
 */
export const AGENT_SCOPES: readonly Scope[] = [
  'attestations:write', 'seals:write', 'determinations:read', 'permits:exercise',
];

const PREFIX_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

function mac(secret: string): string {
  return createHmac('sha256', config.authSecret).update(`key:v1:${secret}`).digest('hex');
}

function randomToken(len: number): string {
  const buf = randomBytes(len);
  let out = '';
  for (const b of buf) out += PREFIX_CHARS[b % PREFIX_CHARS.length];
  return out;
}

export interface MintedKey {
  id: string;
  /** Returned once, at mint time, and never recoverable afterwards. */
  key: string;
  authority: Authority;
  scopes: Scope[];
}

/**
 * Mint a key.
 *
 * `by` is null only for a workspace's very first key, which is created by
 * provisioning rather than by a caller. Every other mint is performed by a key
 * that must strictly outrank what it is creating.
 */
export async function mintKey(args: {
  workspaceId: string;
  authority: Authority;
  scopes: readonly Scope[];
  label: string;
  by: Principal | null;
}): Promise<MintedKey> {
  if (!isAuthority(args.authority)) {
    throw new ApiError(400, 'invalid_request', `authority must be one of: ${AUTHORITIES.join(', ')}.`);
  }
  for (const s of args.scopes) {
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw new ApiError(400, 'invalid_request', `Unknown scope "${s}".`, { scope: s });
    }
  }

  if (args.by !== null) {
    if (args.by.workspaceId !== args.workspaceId) {
      // Never confirm that another workspace exists.
      throw new ApiError(404, 'not_found', 'No such workspace.');
    }
    if (!args.by.scopes.has('keys:mint')) {
      throw new ApiError(403, 'forbidden', 'This key may not mint keys.');
    }
    if (rankOf(args.authority) >= rankOf(args.by.authority)) {
      throw new ApiError(403, 'forbidden',
        `A "${args.by.authority}" key may only mint keys strictly below itself, not `
        + `"${args.authority}". Otherwise the authority ladder is decorative — a key could mint `
        + 'its way above the determinations it is bound by.',
        { minting: args.authority, holder: args.by.authority });
    }
    // A key cannot hand out what it does not hold.
    for (const s of args.scopes) {
      if (!args.by.scopes.has(s)) {
        throw new ApiError(403, 'forbidden',
          `This key does not hold scope "${s}" and so cannot grant it.`, { scope: s });
      }
    }
  }

  const id = newId('key');
  const prefix = randomToken(12);
  const secret = randomToken(40);

  await getPool().query(
    `INSERT INTO api_keys (id, workspace_id, prefix, secret_mac, authority, scopes, label, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, args.workspaceId, prefix, mac(secret), args.authority, args.scopes, args.label,
      args.by?.keyId ?? null]);
  await getPool().query(
    `INSERT INTO key_events (workspace_id, key_id, kind, by_key_id, authority, scopes)
     VALUES ($1,$2,'minted',$3,$4,$5)`,
    [args.workspaceId, id, args.by?.keyId ?? null, args.authority, args.scopes]);

  return { id, key: `crimp_${prefix}_${secret}`, authority: args.authority, scopes: [...args.scopes] };
}

const KEY_SHAPE = /^crimp_([a-z0-9]{12})_([a-z0-9]{40})$/;

/**
 * Verify a presented key.
 *
 * Constant-time comparison, and the comparison runs even for an unknown prefix.
 * Returning early on "no such prefix" turns response latency into an oracle for
 * which prefixes exist, which is a slow but free enumeration of the key space.
 */
/**
 * Stand-in MAC used when no key row exists.
 *
 * It MUST be the same length as a real `secret_mac`. The comparison below is
 * guarded by a length check — `timingSafeEqual` throws on mismatched lengths —
 * so a decoy of the wrong length would short-circuit before comparing, and an
 * unknown prefix would return measurably faster than a known one. That turns
 * response latency into an oracle for which prefixes exist.
 *
 * Exported so a test can assert the length invariant. The timing property
 * itself is not enforced by the suite; see SECURITY.md.
 */
export const DECOY_MAC = 'f'.repeat(64);

export async function verifyKey(presented: string | undefined, db: Db = getPool())
: Promise<Principal> {
  const m = typeof presented === 'string' ? KEY_SHAPE.exec(presented) : null;

  const prefix = m?.[1] ?? '';
  const secret = m?.[2] ?? '';

  const { rows } = prefix === '' ? { rows: [] } : await db.query<{
    id: string; workspace_id: string; secret_mac: string;
    authority: Authority; scopes: string[]; revoked_at: Date | null;
  }>(
    `SELECT id, workspace_id, secret_mac, authority, scopes, revoked_at
       FROM api_keys WHERE prefix = $1`, [prefix]);

  const row = rows[0];
  const expected = Buffer.from(row?.secret_mac ?? DECOY_MAC, 'utf8');
  const actual = Buffer.from(mac(secret), 'utf8');
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!row || !ok || row.revoked_at !== null) {
    throw new ApiError(401, 'unauthorized', 'Missing or invalid API key.');
  }

  // Best-effort; a failure here must never fail the request it is describing.
  void db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id])
    .catch(() => {});

  return {
    workspaceId: row.workspace_id,
    keyId: row.id,
    authority: row.authority,
    scopes: new Set(row.scopes),
  };
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!p.scopes.has(scope)) {
    throw new ApiError(403, 'forbidden',
      `This key is not permitted to perform that action. Required scope: "${scope}".`,
      { required: scope });
  }
}

export async function revokeKey(p: Principal, keyId: string): Promise<void> {
  const { rows } = await getPool().query<{ authority: Authority }>(
    'SELECT authority FROM api_keys WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL',
    [keyId, p.workspaceId]);
  const target = rows[0];
  if (!target) throw new ApiError(404, 'not_found', 'No such key.');

  // A key may revoke itself, or anything strictly below it. It may not revoke
  // its peers or superiors — otherwise an agent whose determinations are
  // inconvenient could revoke the operator key that would have clawed them.
  const self = keyId === p.keyId;
  if (!self && rankOf(target.authority) >= rankOf(p.authority)) {
    throw new ApiError(403, 'forbidden',
      `A "${p.authority}" key may revoke itself or keys strictly below it, not a `
      + `"${target.authority}" key.`, { holder: p.authority, target: target.authority });
  }

  await getPool().query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [keyId]);
  await getPool().query(
    `INSERT INTO key_events (workspace_id, key_id, kind, by_key_id, authority)
     VALUES ($1,$2,'revoked',$3,$4)`,
    [p.workspaceId, keyId, p.keyId, target.authority]);
}
