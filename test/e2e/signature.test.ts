// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * §7.0f end to end: a record sealed by the API, the keys published by the
 * API, and the dependency-free CLI verifying one against the other with
 * nothing else — the way a stranger would.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { mintKey, SCOPES } from '../../src/domain/auth.js';
import { recordCore } from '../../src/domain/record.js';
import { verifyCore } from '../../src/lib/signing.js';
import { freshWorkspace, person } from '../helpers.js';

let app: FastifyInstance;
before(async () => {
  process.env['SIGNING_KEY'] ||= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  await migrate(() => {}); app = buildApp(); await app.ready();
});
after(async () => { await app.close(); await closePool(); });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const RULE = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };

describe('a signed record', () => {
  test('is verified offline by the CLI against the published key, and a tampered copy is not', async () => {
    const ws = await freshWorkspace();
    const agent = (await mintKey({ workspaceId: ws, authority: 'agent', scopes: [...SCOPES], label: 'a', by: null })).key;
    const op = (await mintKey({ workspaceId: ws, authority: 'operator', scopes: [...SCOPES], label: 'o', by: null })).key;
    await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(agent), payload: { aliases: person('sg1'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' },
        { fact: 'prior_refunds_90d', type: 'int', value: 1, source: 'core_ledger' }] } });
    const s = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(agent), payload: {
      idempotency_key: 'sg1', aliases: person('sg1'), scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidence_floor: 'internal' } } });
    assert.equal(s.statusCode, 201, s.body);

    const rec = await app.inject({ method: 'GET', url: `/v1/seals/${s.json().seal_id}`, headers: bearer(op) });
    const record = rec.json();
    assert.equal(record.signature.alg, 'ed25519');
    const keys = await app.inject({ method: 'GET', url: '/.well-known/crimp-keys.json' });
    assert.equal(keys.statusCode, 200);
    assert.equal(keys.json().keys[0].kid, record.signature.kid);

    // The domain agrees with itself: the wire record's core verifies.
    const CORE = ['seal_id', 'scope', 'disposition', 'rule', 'rule_hash', 'grammar_version', 'sealed_by',
      'sealed_at', 'expires_at', 'as_of', 'rule_ref', 'reasons', 'facts', 'remedy'];
    const core = Object.fromEntries(CORE.map((k) => [k, record[k] ?? null]));
    assert.equal(verifyCore(core, record.signature, keys.json().keys[0].public_key), true);
    void recordCore;

    // A stranger with three files and node.
    const dir = mkdtempSync(join(tmpdir(), 'crimp-verify-'));
    writeFileSync(join(dir, 'record.json'), JSON.stringify(record));
    writeFileSync(join(dir, 'keys.json'), keys.body);
    writeFileSync(join(dir, 'values.json'), JSON.stringify({
      'carrier.delivered': { type: 'bool', value: false }, 'prior_refunds_90d': { type: 'int', value: 1 } }));
    const out = execFileSync('node', ['spec/verify-cli.mjs', join(dir, 'record.json'),
      '--values', join(dir, 'values.json'), '--keys', join(dir, 'keys.json')], { encoding: 'utf8' });
    assert.match(out, /ok {4}signature\s+valid under/);
    assert.match(out, /ok {4}re-evaluation/);
    assert.match(out, /verified: every step that could run passed/);

    writeFileSync(join(dir, 'tampered.json'), JSON.stringify({ ...record, disposition: 'permit' }));
    let failed = '';
    try {
      execFileSync('node', ['spec/verify-cli.mjs', join(dir, 'tampered.json'), '--keys', join(dir, 'keys.json')], { encoding: 'utf8' });
    } catch (e) { failed = (e as { stdout: string }).stdout; }
    assert.match(failed, /FAIL {2}signature\s+INVALID/);
    assert.match(failed, /NOT verified/);

    // Without a key the signature is unverifiable, and that is said, not failed.
    const noKey = execFileSync('node', ['spec/verify-cli.mjs', join(dir, 'record.json')], { encoding: 'utf8' });
    assert.match(noKey, /skip {2}signature\s+no published key/);
  });
});
