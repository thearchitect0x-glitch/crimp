// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-06 over HTTP: the review flag is on the lookup and the record, additively. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { mintKey, SCOPES } from '../../src/domain/auth.js';
import { sweepOnce } from '../../src/worker/sweep.js';
import { freshWorkspace, person } from '../helpers.js';

let app: FastifyInstance;
before(async () => { await migrate(() => {}); app = buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };
const CLAW = { authority: 'operator', evidence_floor: 'internal' };

describe('systemic review over HTTP', () => {
  test('a lookup says under_review, and the record says when', async () => {
    const ws = await freshWorkspace();
    const agent = (await mintKey({ workspaceId: ws, authority: 'agent', scopes: [...SCOPES], label: 'a', by: null })).key;
    const op = (await mintKey({ workspaceId: ws, authority: 'operator', scopes: [...SCOPES], label: 'o', by: null })).key;
    await app.inject({ method: 'POST', url: '/v1/rulesets', headers: bearer(op), payload: { ruleset: 'medicaid' } });
    await app.inject({ method: 'POST', url: '/v1/rulesets/medicaid/rules', headers: bearer(op),
      payload: { rule_id: 'renewal.income', rule: RULE, legal_authority: '42 CFR 435.916(b)', effective_from: '2026-01-01T00:00:00Z' } });
    for (const tag of ['a', 'b']) {
      await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(agent), payload: { aliases: person(tag),
        facts: [{ fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' }] } });
      const s = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(agent), payload: {
        idempotency_key: tag, aliases: person(tag), scope: 'medicaid.renewal', disposition: 'bind', claw: CLAW,
        rule_ref: { ruleset: 'medicaid', rule_id: 'renewal.income' } } });
      assert.equal(s.statusCode, 201, s.body);
    }
    const before = await app.inject({ method: 'POST', url: '/v1/determinations/lookup', headers: bearer(agent),
      payload: { aliases: person('b'), scope: 'medicaid.renewal' } });
    assert.equal(before.json().determinations[0].under_review, false);

    await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(agent), payload: { aliases: person('a'),
      facts: [
        { fact: 'adjudication.ruling', type: 'str', value: 'reversed', source: 'state_registry' },
        { fact: 'adjudication.ruleset', type: 'str', value: 'medicaid', source: 'state_registry' },
        { fact: 'adjudication.rule_id', type: 'str', value: 'renewal.income', source: 'state_registry' },
      ] } });
    await sweepOnce();

    const after = await app.inject({ method: 'POST', url: '/v1/determinations/lookup', headers: bearer(agent),
      payload: { aliases: person('b'), scope: 'medicaid.renewal' } });
    assert.equal(after.json().determinations[0].under_review, true);
    assert.equal(after.json().determinations[0].state, 'sealed', 'still standing');
    const rec = await app.inject({ method: 'GET', url: `/v1/seals/${after.json().determinations[0].seal_id}`, headers: bearer(op) });
    assert.equal(typeof rec.json().review_flagged_at, 'string');
    const f = await app.inject({ method: 'GET', url: '/v1/findings?class=systemic_review', headers: bearer(op) });
    assert.equal(f.json().findings[0].detail.count, 2);
  });
});
