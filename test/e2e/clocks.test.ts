// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-03 over HTTP: start, look up, the timeliness figure, the findings list. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { mintKey, SCOPES, AGENT_SCOPES } from '../../src/domain/auth.js';
import { sweepOnce } from '../../src/worker/sweep.js';
import { freshWorkspace, person } from '../helpers.js';

let app: FastifyInstance;
before(async () => { await migrate(() => {}); app = buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe('clocks over HTTP', () => {
  test('an agent starts one; the operator reads the figure and the findings', async () => {
    const ws = await freshWorkspace();
    const narrow = (await mintKey({ workspaceId: ws, authority: 'agent', scopes: [...AGENT_SCOPES], label: 'a', by: null })).key;
    const op = (await mintKey({ workspaceId: ws, authority: 'operator', scopes: [...SCOPES], label: 'o', by: null })).key;

    const start = new Date(Date.now() - 31 * 864e5).toISOString();
    const c = await app.inject({ method: 'POST', url: '/v1/clocks', headers: bearer(narrow),
      payload: { aliases: person('w1'), scope: 'snap.application', clock: 'snap_30_day', started_at: start } });
    assert.equal(c.statusCode, 201, c.body);
    assert.equal(c.json().status, 'running');
    assert.equal(c.json().authority, '7 CFR 273.2(g)(1)');

    const bad = await app.inject({ method: 'POST', url: '/v1/clocks', headers: bearer(narrow),
      payload: { aliases: person('w1'), scope: 'snap.application', clock: 'nope', started_at: start } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'unknown_clock');

    await sweepOnce();

    const look = await app.inject({ method: 'POST', url: '/v1/clocks/lookup', headers: bearer(narrow),
      payload: { aliases: person('w1') } });
    assert.equal(look.json().clocks[0].status, 'missed');

    const t = await app.inject({ method: 'GET', url: '/v1/insight/timeliness', headers: bearer(op) });
    assert.equal(t.statusCode, 200);
    assert.equal(t.json().clocks[0].clock, 'snap_30_day');
    assert.equal(t.json().clocks[0].missed, 1);

    const f = await app.inject({ method: 'GET', url: '/v1/findings?class=agency_timeliness', headers: bearer(op) });
    assert.equal(f.statusCode, 200);
    assert.equal(f.json().findings.length, 1);
    assert.equal(f.json().findings[0].detail.clock, 'snap_30_day');

    const denied = await app.inject({ method: 'GET', url: '/v1/findings', headers: bearer(narrow) });
    assert.equal(denied.statusCode, 403, 'findings are for the institution, not its agents');
  });
});
