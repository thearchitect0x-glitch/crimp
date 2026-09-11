// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-01 over HTTP: the catalogue routes, and the shape of a delivery refusal. */
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

async function keys(): Promise<{ agent: string; operator: string }> {
  const ws = await freshWorkspace();
  const mk = (authority: 'agent' | 'operator') => mintKey({
    workspaceId: ws, authority, scopes: [...SCOPES], label: authority, by: null,
  });
  return { agent: (await mk('agent')).key, operator: (await mk('operator')).key };
}

describe('the catalogue over HTTP', () => {
  test('declare, list, then a refusal that names the guard', async () => {
    const k = await keys();
    const agent = await app.inject({ method: 'POST', url: '/v1/catalogue', headers: bearer(k.agent),
      payload: { fact: 'notice.renewal.delivered_status', fact_type: 'str', class: 'delivery' } });
    assert.equal(agent.statusCode, 403);
    assert.equal(agent.json().error.code, 'insufficient_authority');

    const d = await app.inject({ method: 'POST', url: '/v1/catalogue', headers: bearer(k.operator),
      payload: { fact: 'notice.renewal.delivered_status', fact_type: 'str', class: 'delivery' } });
    assert.equal(d.statusCode, 201, d.body);
    assert.deepEqual(d.json().allowed_values, ['delivered', 'returned', 'unknown']);
    const n = await app.inject({ method: 'POST', url: '/v1/catalogue', headers: bearer(k.operator),
      payload: { fact: 'renewal.returned', fact_type: 'bool', class: 'non_response',
        guarded_by: 'notice.renewal.delivered_status' } });
    assert.equal(n.statusCode, 201, n.body);
    assert.equal(n.json().guard_value, 'delivered');

    const list = await app.inject({ method: 'GET', url: '/v1/catalogue', headers: bearer(k.operator) });
    assert.deepEqual(list.json().facts.map((f: { fact: string }) => f.fact),
      ['notice.renewal.delivered_status', 'renewal.returned']);

    await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(k.agent),
      payload: { aliases: person('h1'), facts: [
        { fact: 'renewal.returned', type: 'bool', value: false, source: 'state_registry' },
        { fact: 'notice.renewal.delivered_status', type: 'str', value: 'unknown', source: 'state_registry' },
      ] } });
    // A procedural rule is committed policy (cap-07), so it is sealed by reference.
    await app.inject({ method: 'POST', url: '/v1/rulesets', headers: bearer(k.operator), payload: { ruleset: 'medicaid' } });
    const c = await app.inject({ method: 'POST', url: '/v1/rulesets/medicaid/rules', headers: bearer(k.operator),
      payload: { rule_id: 'renewal.procedural', rule: { fact: 'renewal.returned', op: 'eq', value: false },
        legal_authority: '42 CFR 435.916(b)', effective_from: '2026-01-01T00:00:00Z' } });
    assert.equal(c.statusCode, 201, c.body);
    const s = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'h1', aliases: person('h1'), scope: 'medicaid.renewal',
        disposition: 'bind', claw: { authority: 'operator', evidence_floor: 'internal' },
        rule_ref: { ruleset: 'medicaid', rule_id: 'renewal.procedural' } } });
    assert.equal(s.statusCode, 409, s.body);
    assert.equal(s.json().error.code, 'facts_not_attested');
    assert.equal(s.json().error.detail.guarded[0].reason, 'delivery_unattested');
    assert.equal(s.json().error.detail.guarded[0].observed, 'unknown');
  });

  test('a typo in a catalogue body is refused, not dropped', async () => {
    const k = await keys();
    const r = await app.inject({ method: 'POST', url: '/v1/catalogue', headers: bearer(k.operator),
      payload: { fact: 'x', fact_type: 'int', klass: 'plain' } });
    assert.equal(r.statusCode, 400);
  });
});
