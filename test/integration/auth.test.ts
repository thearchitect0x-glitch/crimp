// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import {
  mintKey, verifyKey, revokeKey, requireScope, AGENT_SCOPES, SCOPES, DECOY_MAC,
  type Principal,
} from '../../src/domain/auth.js';
import { seal, lookup, claw } from '../../src/domain/seal.js';
import { attest } from '../../src/domain/attest.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, freshWorkspace, person, STRENGTHS, hash64 } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';
import type { Authority } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'carrier.delivered', op: 'eq', value: false };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    return true;
  }, why);
}

async function root(ws: string, authority: Authority = 'custodian'): Promise<Principal> {
  const k = await mintKey({ workspaceId: ws, authority, scopes: [...SCOPES], label: 'root', by: null });
  return verifyKey(k.key);
}

describe('key verification', () => {
  test('a minted key verifies to the authority it was minted with', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'operator',
      scopes: [...AGENT_SCOPES], label: 'ops', by: null });
    const p = await verifyKey(k.key);
    assert.equal(p.workspaceId, ws);
    assert.equal(p.authority, 'operator');
    assert.deepEqual([...p.scopes].sort(), [...AGENT_SCOPES].sort());
  });

  test('the secret is never recoverable from the database', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'a', by: null });
    const secret = k.key.split('_')[2]!;
    const { rows } = await getPool().query<{ secret_mac: string }>(
      'SELECT secret_mac FROM api_keys WHERE id = $1', [k.id]);
    assert.ok(!rows[0]!.secret_mac.includes(secret), 'stored as a peppered MAC, not the secret');
    assert.match(rows[0]!.secret_mac, /^[0-9a-f]{64}$/);
  });

  test('every way of getting it wrong is the same 401', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'a', by: null });
    const [, prefix, secret] = k.key.split('_');

    const bad = [
      undefined,
      '',
      'garbage',
      'crimp_tooshort_x',
      `crimp_${prefix}_${'a'.repeat(40)}`,          // right prefix, wrong secret
      `crimp_${'zzzzzzzzzzzz'}_${secret}`,          // unknown prefix, right secret
      k.key.toUpperCase(),
    ];
    for (const b of bad) {
      await refuses(() => verifyKey(b as string), 'unauthorized', JSON.stringify(b));
    }
  });

  test('the decoy MAC matches a real one in length, so the compare is always reached', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'a', by: null });
    const { rows } = await getPool().query<{ secret_mac: string }>(
      'SELECT secret_mac FROM api_keys WHERE id = $1', [k.id]);
    assert.equal(DECOY_MAC.length, rows[0]!.secret_mac.length,
      'a shorter decoy would fail the length guard and skip timingSafeEqual entirely, '
      + 'making an unknown prefix measurably faster than a known one');
  });

  test('a revoked key stops working', async () => {
    const ws = await freshWorkspace();
    const admin = await root(ws);
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'a', by: admin });
    await verifyKey(k.key);
    await revokeKey(admin, k.id);
    await refuses(() => verifyKey(k.key), 'unauthorized', 'revoked key');
  });
});

describe('the authority ladder governs its own issuance', () => {
  test('an agent key mints nothing at all', async () => {
    const ws = await freshWorkspace();
    const admin = await root(ws);
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...SCOPES], label: 'agent', by: admin });
    const agent = await verifyKey(k.key);

    for (const level of ['agent', 'operator', 'principal', 'custodian'] as Authority[]) {
      await refuses(() => mintKey({ workspaceId: ws, authority: level,
        scopes: [...AGENT_SCOPES], label: 'x', by: agent }),
      'forbidden',
      `an agent minting a ${level} key defeats invariant III by one indirection`);
    }
  });

  test('a key mints only strictly below itself — never a peer', async () => {
    const ws = await freshWorkspace();
    const admin = await root(ws, 'principal');
    await mintKey({ workspaceId: ws, authority: 'operator',
      scopes: [...AGENT_SCOPES], label: 'ok', by: admin });
    await refuses(() => mintKey({ workspaceId: ws, authority: 'principal',
      scopes: [...AGENT_SCOPES], label: 'peer', by: admin }),
    'forbidden', 'a peer key is a way to launder authority sideways');
  });

  test('a key cannot grant a scope it does not hold', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'principal',
      scopes: ['keys:mint', 'seals:write'], label: 'narrow', by: null });
    const narrow = await verifyKey(k.key);
    await refuses(() => mintKey({ workspaceId: ws, authority: 'operator',
      scopes: ['seals:claw'], label: 'x', by: narrow }),
    'forbidden', 'you cannot hand out what you were never given');
  });

  test('minting requires the keys:mint scope', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'custodian',
      scopes: ['seals:write'], label: 'no-mint', by: null });
    const holder = await verifyKey(k.key);
    await refuses(() => mintKey({ workspaceId: ws, authority: 'agent',
      scopes: ['seals:write'], label: 'x', by: holder }),
    'forbidden', 'high authority is not the same as permission to issue');
  });

  test('a cross-workspace mint is a 404, never a hint the workspace exists', async () => {
    const [a, b] = [await freshWorkspace(), await freshWorkspace()];
    const admin = await root(a);
    await refuses(() => mintKey({ workspaceId: b, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'x', by: admin }), 'not_found', 'tenant isolation');
  });

  test('every mint is on the record', async () => {
    const ws = await freshWorkspace();
    const admin = await root(ws);
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'a', by: admin });
    const { rows } = await getPool().query<{ kind: string; by_key_id: string | null }>(
      'SELECT kind, by_key_id FROM key_events WHERE key_id = $1', [k.id]);
    assert.equal(rows[0]?.kind, 'minted');
    assert.equal(rows[0]?.by_key_id, admin.keyId, 'who issued it is auditable after an incident');
  });
});

describe('revocation follows the same ladder', () => {
  test('a key may revoke itself', async () => {
    const ws = await freshWorkspace();
    const admin = await root(ws);
    const k = await mintKey({ workspaceId: ws, authority: 'operator',
      scopes: [...SCOPES], label: 'self', by: admin });
    const p = await verifyKey(k.key);
    await revokeKey(p, p.keyId);
    await refuses(() => verifyKey(k.key), 'unauthorized', 'self-revoked');
  });

  test('an agent cannot revoke the operator key that would claw its determinations', async () => {
    const ws = await freshWorkspace();
    const admin = await root(ws);
    const opKey = await mintKey({ workspaceId: ws, authority: 'operator',
      scopes: [...SCOPES], label: 'op', by: admin });
    const agentKey = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...SCOPES], label: 'agent', by: admin });
    const agent = await verifyKey(agentKey.key);

    await refuses(() => revokeKey(agent, opKey.id), 'forbidden',
      'otherwise an agent removes its own supervisor and invariant III is gone');
    await verifyKey(opKey.key);  // still works
  });
});

describe('scopes', () => {
  test('the quickstart scope set cannot claw', () => {
    const p: Principal = {
      workspaceId: 'ws', keyId: 'k', authority: 'agent', jurisdiction: null, scopes: new Set(AGENT_SCOPES),
    };
    assert.throws(() => requireScope(p, 'seals:claw'), (e: unknown) => {
      assert.equal((e as ApiError).code, 'forbidden');
      return true;
    }, 'Ratchet learned this the expensive way; here it is the default from commit one');
    requireScope(p, 'seals:write');
  });

  test('a key without seals:write cannot seal, whatever its authority', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'custodian',
      scopes: ['determinations:read'], label: 'reader', by: null });
    const reader = await verifyKey(k.key);
    await refuses(() => seal(reader, { idempotencyKey: 'idem-s1', aliases: person('s1'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS),
    'forbidden', 'authority and permission are different questions');
  });

  test('a key without attestations:write cannot attest', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'operator',
      scopes: ['determinations:read'], label: 'reader', by: null });
    const reader = await verifyKey(k.key);
    await refuses(() => attest(reader, { aliases: person('s2'),
      facts: [{ fact: 'x', type: 'bool', value: true, source: 'core_ledger' }] }, STRENGTHS),
    'forbidden', 'scope is checked before anything is written');
  });
});

describe('authority cannot be asserted', () => {
  test('the seal records the CREDENTIAL authority, not anything the caller said', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('z1'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);

    // The input object has no `sealedBy` field to set. Passing one is a type
    // error at compile time and an ignored property at runtime; either way it
    // cannot reach the row. The proof is what actually got stored.
    const s = await seal(A.agent, {
      idempotencyKey: 'idem-z1',
      aliases: person('z1'), scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW,
      ...({ sealedBy: 'custodian' } as object),
    } as never, STRENGTHS);

    const { rows } = await getPool().query<{ sealed_by: string }>(
      'SELECT sealed_by FROM seals WHERE id = $1', [s.sealId]);
    assert.equal(rows[0]?.sealed_by, 'agent',
      'a caller claiming custodian is still recorded as what its key actually is');
  });

  test('and so the claw ladder cannot be climbed by claiming', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('z2'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);
    const s = await seal(A.agent, { idempotencyKey: 'idem-z2', aliases: person('z2'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    // There is no `actor` parameter either. The agent key claws as an agent.
    await refuses(() => claw(A.agent, { sealId: s.sealId!,
      evidenceSha256: hash64('e'), evidenceClass: 'receipt' }),
    'insufficient_authority', 'the whole product rests on this being unforgeable');

    await claw(A.operator, { sealId: s.sealId!,
      evidenceSha256: hash64('e'), evidenceClass: 'receipt' });
  });

  test('a key from another workspace cannot reach these seals at all', async () => {
    const [A, B] = [await actors(), await actors()];
    await attest(A.agent, { aliases: person('z3'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);
    await seal(A.agent, { idempotencyKey: 'idem-z3', aliases: person('z3'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    const out = await lookup(B.agent, { aliases: person('z3'), scope: 'refund' }, STRENGTHS);
    assert.deepEqual(out.determinations, [],
      'the workspace comes from the key, so there is nothing to spoof');
  });
});
