// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-10 over HTTP: the body has no place for an outcome, and the schema says so. */
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
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };

describe('a decision over HTTP', () => {
  test('accepts a committed rule and facts, and refuses every shape of "outcome"', async () => {
    const ws = await freshWorkspace();
    const agent = (await mintKey({ workspaceId: ws, authority: 'agent', scopes: [...SCOPES], label: 'a', by: null })).key;
    const op = (await mintKey({ workspaceId: ws, authority: 'operator', scopes: [...SCOPES], label: 'o', by: null })).key;
    await app.inject({ method: 'POST', url: '/v1/rulesets', headers: bearer(op), payload: { ruleset: 'medicaid' } });
    const c = await app.inject({ method: 'POST', url: '/v1/rulesets/medicaid/rules', headers: bearer(op),
      payload: { rule_id: 'renewal.income', rule: RULE, legal_authority: '42 CFR 435.916(b)',
        effective_from: '2026-01-01T00:00:00Z', disposition: 'bind' } });
    assert.equal(c.statusCode, 201, c.body);
    assert.equal(c.json().disposition, 'bind');

    const good = { idempotency_key: 'd1', aliases: person('d1'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', rule_id: 'renewal.income',
      facts: [{ fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' }] };

    for (const [name, extra] of [
      ['outcome', { outcome: 'denied' }], ['decision', { decision: 'deny' }],
      ['disposition', { disposition: 'bind' }], ['rule', { rule: RULE }],
    ] as const) {
      const r = await app.inject({ method: 'POST', url: '/v1/decisions', headers: bearer(op), payload: { ...good, ...extra } });
      assert.equal(r.statusCode, 400, `${name} is not a field`);
    }
    const noSource = await app.inject({ method: 'POST', url: '/v1/decisions', headers: bearer(op),
      payload: { ...good, facts: [{ fact: 'household.income', type: 'int', value: 3000 }] } });
    assert.equal(noSource.statusCode, 400, 'a fact without a source');

    const asAgent = await app.inject({ method: 'POST', url: '/v1/decisions', headers: bearer(agent), payload: good });
    assert.equal(asAgent.statusCode, 403);
    assert.equal(asAgent.json().error.code, 'insufficient_authority');

    const r = await app.inject({ method: 'POST', url: '/v1/decisions', headers: bearer(op), payload: good });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().outcome, 'sealed');
    assert.equal(r.json().disposition, 'bind');
    assert.equal(r.json().attested, 1);
    assert.match(r.json().attester, /^key_/);
    assert.equal(r.json().rule_ref.rule_id, 'renewal.income');
  });
});
