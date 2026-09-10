// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** The API serves the format's home, after its own routes; and a notice says where to check. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { mintKey, SCOPES } from '../../src/domain/auth.js';
import { freshWorkspace, person } from '../helpers.js';

let app: FastifyInstance;
before(async () => { await migrate(() => {}); app = buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe('the format\'s home', () => {
  test('is served at /, the verifier at /verify.html, the vectors as JSON, and nothing else invents a page', async () => {
    const home = await app.inject({ method: 'GET', url: '/' });
    assert.equal(home.statusCode, 200);
    assert.match(home.headers['content-type'] as string, /^text\/html/);
    assert.match(home.body, /Verify a record/);
    const v = await app.inject({ method: 'GET', url: '/verify.html' });
    assert.equal(v.statusCode, 200);
    assert.match(v.body, /Check a refusal without trusting whoever issued it/);
    const vec = await app.inject({ method: 'GET', url: '/spec/vectors.json' });
    assert.equal(vec.statusCode, 200);
    assert.equal(vec.json().spec_version, '0.2');
    const spec = await app.inject({ method: 'GET', url: '/spec/' });
    assert.equal(spec.statusCode, 200);
    assert.match(spec.body, /The Determination Format/);
    const missing = await app.inject({ method: 'GET', url: '/no-such-page' });
    assert.equal(missing.statusCode, 404);
    // The API's own routes still win.
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/.well-known/crimp-keys.json' })).statusCode, 200);
  });

  test('a notice says where to check once VERIFY_URL is set, and only then', async () => {
    const ws = await freshWorkspace();
    const agent = (await mintKey({ workspaceId: ws, authority: 'agent', scopes: [...SCOPES], label: 'a', by: null })).key;
    const op = (await mintKey({ workspaceId: ws, authority: 'operator', scopes: [...SCOPES], label: 'o', by: null })).key;
    await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(agent), payload: { aliases: person('u1'),
      facts: [{ fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' }] } });
    const s = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(agent), payload: {
      idempotency_key: 'u1', aliases: person('u1'), scope: 'medicaid.renewal', disposition: 'bind',
      rule: { fact: 'household.income', op: 'gt', value: 2000 }, claw: { authority: 'operator', evidence_floor: 'internal' } } });
    assert.equal(s.statusCode, 201, s.body);
    const id = s.json().seal_id;

    const saved = process.env['VERIFY_URL'];
    delete process.env['VERIFY_URL'];
    try {
      const plain = await app.inject({ method: 'POST', url: `/v1/seals/${id}/notice?format=text`, headers: bearer(op) });
      assert.equal(plain.body.includes('Check it at'), false);
      process.env['VERIFY_URL'] = 'https://format.example/';
      const told = await app.inject({ method: 'POST', url: `/v1/seals/${id}/notice?format=text`, headers: bearer(op) });
      assert.match(told.body, /Check it at https:\/\/format\.example\/verify\.html/);
      const html = await app.inject({ method: 'POST', url: `/v1/seals/${id}/notice?format=html`, headers: bearer(op) });
      assert.match(html.body, /<a href="https:\/\/format\.example\/verify\.html">/);
    } finally {
      if (saved === undefined) delete process.env['VERIFY_URL']; else process.env['VERIFY_URL'] = saved;
    }
  });
});
