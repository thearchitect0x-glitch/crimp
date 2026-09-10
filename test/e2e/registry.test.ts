// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-08 over HTTP: the scope, the authority gate, the body shapes, the wire fields. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { mintKey, SCOPES, AGENT_SCOPES } from '../../src/domain/auth.js';
import { freshWorkspace, person } from '../helpers.js';

let app: FastifyInstance;
before(async () => { await migrate(() => {}); app = buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function keys(): Promise<{ agent: string; operator: string; narrow: string }> {
  const ws = await freshWorkspace();
  const mk = (authority: 'agent' | 'operator', scopes: readonly string[]) => mintKey({
    workspaceId: ws, authority, scopes: [...scopes] as never, label: authority, by: null,
  });
  return {
    agent: (await mk('agent', SCOPES)).key,
    operator: (await mk('operator', SCOPES)).key,
    narrow: (await mk('agent', AGENT_SCOPES)).key,
  };
}

const RULE = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };
const CLAW = { authority: 'operator', evidence_floor: 'internal' };

describe('the registry over HTTP', () => {
  test('rules:write is not an agent scope, and holding it is still not enough', async () => {
    const k = await keys();
    const narrow = await app.inject({ method: 'POST', url: '/v1/rulesets',
      headers: bearer(k.narrow), payload: { ruleset: 'refunds' } });
    assert.equal(narrow.statusCode, 403);
    assert.equal(narrow.json().error.code, 'forbidden');

    const agent = await app.inject({ method: 'POST', url: '/v1/rulesets',
      headers: bearer(k.agent), payload: { ruleset: 'refunds' } });
    assert.equal(agent.statusCode, 403);
    assert.equal(agent.json().error.code, 'insufficient_authority');

    const op = await app.inject({ method: 'POST', url: '/v1/rulesets',
      headers: bearer(k.operator), payload: { ruleset: 'refunds' } });
    assert.equal(op.statusCode, 201);
  });

  test('commit, commit again, read the history, seal under it, read the record', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/rulesets',
      headers: bearer(k.operator), payload: { ruleset: 'refunds' } });

    const body = { rule_id: 'refund.eligibility', rule: RULE,
      legal_authority: '12 CFR 1026.13(e)', effective_from: '2026-01-01T00:00:00Z' };
    const c1 = await app.inject({ method: 'POST', url: '/v1/rulesets/refunds/rules',
      headers: bearer(k.operator), payload: body });
    assert.equal(c1.statusCode, 201, c1.body);
    assert.equal(c1.json().outcome, 'committed');
    assert.match(c1.json().version, /^[0-9a-f]{64}$/);
    const c2 = await app.inject({ method: 'POST', url: '/v1/rulesets/refunds/rules',
      headers: bearer(k.operator), payload: body });
    assert.equal(c2.statusCode, 200);
    assert.equal(c2.json().outcome, 'already_committed');

    const h = await app.inject({ method: 'GET', url: '/v1/rulesets/refunds/rules/refund.eligibility',
      headers: bearer(k.operator) });
    assert.equal(h.statusCode, 200);
    assert.equal(h.json().versions.length, 1);
    assert.equal(h.json().versions[0].legal_authority, '12 CFR 1026.13(e)');

    await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(k.agent),
      payload: { aliases: person('w1'), facts: [
        { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' },
        { fact: 'prior_refunds_90d', type: 'int', value: 1, source: 'core_ledger' },
      ] } });
    const s = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'w1', aliases: person('w1'), scope: 'refund',
        disposition: 'bind', claw: CLAW,
        rule_ref: { ruleset: 'refunds', rule_id: 'refund.eligibility' },
        as_of: '2026-03-01T00:00:00Z' } });
    assert.equal(s.statusCode, 201, s.body);
    assert.equal(s.json().rule_ref.version, s.json().rule_hash);
    assert.equal(s.json().rule_ref.rule_id, 'refund.eligibility');

    const rec = await app.inject({ method: 'GET', url: `/v1/seals/${s.json().seal_id}`,
      headers: bearer(k.operator) });
    assert.equal(rec.json().as_of, '2026-03-01T00:00:00.000Z');
    assert.equal(rec.json().rule_ref.legal_authority, '12 CFR 1026.13(e)');
    assert.deepEqual(rec.json().rule, RULE, 'the rule stays inline in the record');
    // `verify` crosses the wire as-is, camelCase keys included — pre-existing, noted in the changelog.
    assert.equal(typeof rec.json().verify.ruleRef, 'string');
  });

  test('a seal body needs a rule or a rule_ref; a typo in either is refused, not dropped', async () => {
    const k = await keys();
    const neither = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'x', aliases: person('x'), scope: 'refund',
        disposition: 'bind', claw: CLAW } });
    assert.equal(neither.statusCode, 400);
    const typo = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'x', aliases: person('x'), scope: 'refund',
        disposition: 'bind', claw: CLAW, rule_ref: { ruleset: 'refunds', ruleid: 'r' } } });
    assert.equal(typo.statusCode, 400);
    const badDate = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'x', aliases: person('x'), scope: 'refund',
        disposition: 'bind', claw: CLAW, rule: RULE, as_of: 'yesterday' } });
    assert.equal(badDate.statusCode, 400);
    assert.match(badDate.json().error.message, /as_of/);
  });

  test('a bad citation is refused with a message that says what one looks like', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/rulesets',
      headers: bearer(k.operator), payload: { ruleset: 'refunds' } });
    const r = await app.inject({ method: 'POST', url: '/v1/rulesets/refunds/rules',
      headers: bearer(k.operator), payload: { rule_id: 'r', rule: RULE,
        legal_authority: '??', effective_from: '2026-01-01T00:00:00Z' } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'invalid_citation');
  });

  test('an inline-rule record has the new fields as null — old shape, still valid', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(k.agent),
      payload: { aliases: person('o1'), facts: [
        { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' },
        { fact: 'prior_refunds_90d', type: 'int', value: 1, source: 'core_ledger' },
      ] } });
    const s = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'o1', aliases: person('o1'), scope: 'refund',
        disposition: 'bind', claw: CLAW, rule: RULE } });
    assert.equal(s.statusCode, 201);
    assert.equal(s.json().rule_ref, null);
    const rec = await app.inject({ method: 'GET', url: `/v1/seals/${s.json().seal_id}`,
      headers: bearer(k.operator) });
    assert.equal(rec.json().as_of, null);
    assert.equal(rec.json().rule_ref, null);
  });
});

describe('the notice over HTTP', () => {
  test('text, html and json forms of one record', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(k.agent),
      payload: { aliases: person('nt1'), facts: [
        { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' },
        { fact: 'prior_refunds_90d', type: 'int', value: 1, source: 'core_ledger' },
      ] } });
    const s = await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'nt1', aliases: person('nt1'), scope: 'snap.refund',
        disposition: 'bind', claw: CLAW, rule: RULE } });
    assert.equal(s.statusCode, 201, s.body);
    const id = s.json().seal_id;

    const text = await app.inject({ method: 'POST', url: `/v1/seals/${id}/notice?format=text`, headers: bearer(k.operator) });
    assert.equal(text.statusCode, 200, text.body);
    assert.match(text.headers['content-type'] as string, /^text\/plain/);
    assert.match(text.body, /^Notice of decision\n/);
    const html = await app.inject({ method: 'POST', url: `/v1/seals/${id}/notice?format=html`, headers: bearer(k.operator) });
    assert.match(html.headers['content-type'] as string, /^text\/html/);
    assert.match(html.body, /<article class="notice"/);
    const json = await app.inject({ method: 'POST', url: `/v1/seals/${id}/notice`, headers: bearer(k.operator) });
    assert.equal(json.json().readability.target, 8);
    assert.equal(json.json().notice.appeal.programme, 'SNAP');

    const unconfigured = await app.inject({ method: 'POST', url: `/v1/seals/${id}/notice?language=fr`, headers: bearer(k.operator) });
    assert.equal(unconfigured.statusCode, 400);
    assert.equal(unconfigured.json().error.code, 'language_unavailable');
  });
});
