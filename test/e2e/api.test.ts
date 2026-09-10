// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Real HTTP through `app.inject` — auth, validation, headers, status codes.
 *
 * These exist to catch what the integration tests structurally cannot: a domain
 * function can be perfect while the route in front of it forgets to check a
 * scope, leaks a field, or accepts a body shape nobody intended.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { mintKey, SCOPES, AGENT_SCOPES } from '../../src/domain/auth.js';
import { freshWorkspace, person, hash64 } from '../helpers.js';

let app: FastifyInstance;

before(async () => {
  await migrate(() => {});
  app = buildApp();
  await app.ready();
});
after(async () => { await app.close(); await closePool(); });

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function keys(): Promise<{
  ws: string; agent: string; operator: string; principal: string; narrow: string;
}> {
  const ws = await freshWorkspace();
  const agent = await mintKey({ workspaceId: ws, authority: 'agent',
    scopes: [...SCOPES], label: 'agent', by: null });
  const operator = await mintKey({ workspaceId: ws, authority: 'operator',
    scopes: [...SCOPES], label: 'op', by: null });
  const principal = await mintKey({ workspaceId: ws, authority: 'principal',
    scopes: [...SCOPES], label: 'principal', by: null });
  const narrow = await mintKey({ workspaceId: ws, authority: 'agent',
    scopes: [...AGENT_SCOPES], label: 'narrow', by: null });
  return { ws, agent: agent.key, operator: operator.key,
    principal: principal.key, narrow: narrow.key };
}

const FACTS = (delivered = false, refunds = 1) => [
  { fact: 'carrier.delivered', type: 'bool', value: delivered, source: 'carrier_api' },
  { fact: 'prior_refunds_90d', type: 'int', value: refunds, source: 'core_ledger' },
];
const RULE = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };
const CLAW = { authority: 'operator', evidence_floor: 'internal' };

describe('the door', () => {
  test('every route refuses an absent, malformed or bogus key the same way', async () => {
    for (const headers of [{}, bearer(''), bearer('garbage'), { authorization: 'Basic x' }]) {
      const r = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
        headers, payload: { aliases: person('x'), scope: 'refund' } });
      assert.equal(r.statusCode, 401, JSON.stringify(headers));
      assert.equal(r.json().error.code, 'unauthorized');
    }
  });

  test('health needs no key and says nothing about the system', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });
  });

  test('security headers are on every response', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  });

  test('API responses are never cacheable by a shared proxy', async () => {
    const k = await keys();
    const r = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
      headers: bearer(k.agent), payload: { aliases: person('cache'), scope: 'refund' } });
    assert.equal(r.headers['cache-control'], 'no-store', 'responses are per-key');
  });

  test('an unknown route is a 404 with the standard error shape', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/nope' });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error.code, 'not_found');
  });
});

describe('validation refuses rather than silently drops', () => {
  test('an unknown body field is rejected, not ignored', async () => {
    const k = await keys();
    const r = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
      headers: bearer(k.agent),
      payload: { aliases: person('v'), scope: 'refund', cooling_off_second: 60 } });
    assert.equal(r.statusCode, 400,
      'a typo that is quietly dropped costs somebody a week');
    assert.equal(r.json().error.code, 'invalid_request');
  });

  test('there is no field through which to claim authority', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent), payload: { aliases: person('auth'), facts: FACTS() } });

    const r = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent),
      payload: { idempotency_key: 'idem-auth', aliases: person('auth'), scope: 'refund', disposition: 'bind',
        rule: RULE, claw: CLAW, sealed_by: 'custodian' } });
    assert.equal(r.statusCode, 400, 'the schema has no sealed_by, so this is a typo, not a bypass');
  });

  test('a malformed rule names the offending node', async () => {
    const k = await keys();
    const r = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent),
      payload: { idempotency_key: 'idem-r', aliases: person('r'), scope: 'refund', disposition: 'bind',
        rule: { all: [] }, claw: CLAW } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'invalid_rule');
    assert.match(r.json().error.message, /at least one rule/);
  });

  test('an undeclared alias type is refused with its own code', async () => {
    const k = await keys();
    const r = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
      headers: bearer(k.agent),
      payload: { aliases: [{ type: 'browser_hash', value: 'x' }], scope: 'refund' } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'unknown_alias_type');
  });
});

describe('the full loop over HTTP', () => {
  test('attest, seal, check, claw', async () => {
    const k = await keys();

    const a = await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent), payload: { aliases: person('loop'), facts: FACTS() } });
    assert.equal(a.statusCode, 200);
    assert.equal(a.json().subject_id, undefined,
      'the subject id is the join key; returning it links two identifiers for two writes');

    const s = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent),
      payload: { idempotency_key: 'idem-loop', aliases: person('loop'), scope: 'refund', disposition: 'bind',
        rule: RULE, claw: CLAW } });
    assert.equal(s.statusCode, 201, 'a determination now exists');
    const sealed = s.json();
    assert.equal(sealed.outcome, 'sealed');
    assert.match(sealed.rule_hash, /^[0-9a-f]{64}$/);
    assert.equal(sealed.snake_case_only, undefined);
    assert.equal(Object.keys(sealed).some((x) => /[A-Z]/.test(x)), false,
      'nothing camelCase escapes onto the wire');

    const c = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
      headers: bearer(k.agent),
      payload: { aliases: person('loop'), scope: 'refund.issue' } });
    assert.equal(c.statusCode, 200);
    const d = c.json().determinations;
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'bind.refusal_standing');
    assert.equal(c.json().bound, undefined, 'no verdict — Crimp reports, the caller decides');
    assert.equal(c.json().binding_token, undefined, 'and issues no permission artifact');

    const bad = await app.inject({ method: 'POST', url: `/v1/seals/${sealed.seal_id}/claw`,
      headers: bearer(k.agent),
      payload: { evidence_sha256: hash64('e'), evidence_class: 'internal' } });
    assert.equal(bad.statusCode, 403, 'an agent cannot lift what it sealed');
    assert.equal(bad.json().error.code, 'insufficient_authority');

    const ok = await app.inject({ method: 'POST', url: `/v1/seals/${sealed.seal_id}/claw`,
      headers: bearer(k.operator),
      payload: { evidence_sha256: hash64('e'), evidence_class: 'internal' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().state, 'clawed');
  });

  test('a rule that does not hold is 200 and not_applicable, not an error', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent), payload: { aliases: person('na'), facts: FACTS(false, 9) } });
    const s = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent),
      payload: { idempotency_key: 'idem-na', aliases: person('na'), scope: 'refund', disposition: 'bind',
        rule: RULE, claw: CLAW } });
    assert.equal(s.statusCode, 200, 'the agent applied its rule and the rule did not hold');
    assert.equal(s.json().outcome, 'not_applicable');
    assert.equal(s.json().seal_id, null);
  });

  test('sealing on unattested facts is a 409 naming what is missing', async () => {
    const k = await keys();
    const s = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent),
      payload: { idempotency_key: 'idem-miss', aliases: person('miss'), scope: 'refund', disposition: 'bind',
        rule: RULE, claw: CLAW } });
    assert.equal(s.statusCode, 409);
    assert.equal(s.json().error.code, 'facts_not_attested');
    assert.deepEqual(s.json().error.detail.missing.sort(),
      ['carrier.delivered', 'prior_refunds_90d']);
  });
});

describe('the contract fields', () => {
  test('a seal without an idempotency key is refused at the schema', async () => {
    const k = await keys();
    const r = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent),
      payload: { aliases: person('nk'), scope: 'refund', disposition: 'bind',
        rule: RULE, claw: CLAW } });
    assert.equal(r.statusCode, 400,
      'an at-most-once guarantee a caller can forget to opt into is not a guarantee');
    assert.equal(r.json().error.code, 'invalid_request');
  });

  test('a retried POST is 200 and replayed, not 201 and a second determination', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent), payload: { aliases: person('rp'), facts: FACTS() } });
    const body = { idempotency_key: 'idem-rp', aliases: person('rp'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW };

    const first = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent), payload: body });
    const again = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent), payload: body });

    assert.equal(first.statusCode, 201);
    assert.equal(again.statusCode, 200, '201 would claim something was created');
    assert.equal(again.json().outcome, 'replayed');
    assert.equal(again.json().seal_id, first.json().seal_id);
  });

  test('an unparseable expires_at is refused rather than treated as no expiry', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent), payload: { aliases: person('bx'), facts: FACTS() } });
    const r = await app.inject({ method: 'POST', url: '/v1/seals',
      headers: bearer(k.agent),
      payload: { idempotency_key: 'idem-bx', expires_at: 'next tuesday',
        aliases: person('bx'), scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW } });
    assert.equal(r.statusCode, 400, 'silently binding forever is the worst reading of this');
    assert.equal(r.json().error.code, 'invalid_request');
  });

  test('a cohort placement echoes the subject and never the band', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent), payload: { aliases: person('co'), facts: FACTS() } });
    const d = await app.inject({ method: 'POST', url: '/v1/cohorts',
      headers: bearer(k.operator), payload: { cohort: 'region', description: 'service region' } });
    assert.equal(d.statusCode, 201);

    const pl = await app.inject({ method: 'POST', url: '/v1/cohorts/placements',
      headers: bearer(k.operator),
      payload: { aliases: person('co'), cohort: 'region', band: 'north' } });
    assert.equal(pl.statusCode, 201);
    assert.equal(pl.json().subject_id, undefined);
    assert.equal(JSON.stringify(pl.json()).includes('north'), false,
      'echoing the band back would make this a read path for the value it blinds');
  });
});

describe('subject merge over HTTP', () => {
  test('the dead end is gone: a 409 that names the way through, and it works', async () => {
    const k = await keys();
    const one = [{ type: 'card_fp', value: 'http-1' }];
    const two = [{ type: 'gov_id', value: 'http-2' }];
    for (const aliases of [one, two]) {
      await app.inject({ method: 'POST', url: '/v1/attestations',
        headers: bearer(k.agent), payload: { aliases, facts: FACTS() } });
    }

    const stuck = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
      headers: bearer(k.agent), payload: { aliases: [...one, ...two], scope: 'refund' } });
    assert.equal(stuck.statusCode, 409);
    assert.equal(stuck.json().error.code, 'merge_required');
    assert.match(stuck.json().error.message, /POST \/v1\/subjects\/merge/);

    const m = await app.inject({ method: 'POST', url: '/v1/subjects/merge',
      headers: bearer(k.principal),
      payload: { aliases: [...one, ...two], evidence_sha256: hash64('e'),
        evidence_class: 'internal' } });
    assert.equal(m.statusCode, 200, 'a merge destroys rather than creates; 201 would be a lie');
    assert.equal(m.json().outcome, 'merged');
    assert.equal(m.json().absorbed, 1);
    assert.equal(Object.keys(m.json()).some((x) => /[A-Z]/.test(x)), false);

    const ok = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
      headers: bearer(k.agent), payload: { aliases: [...one, ...two], scope: 'refund' } });
    assert.equal(ok.statusCode, 200, 'the caller is unstuck');
  });

  test('an operator key cannot merge, and the body has no subject ids to name', async () => {
    const k = await keys();
    const payload = { aliases: person('nope'), evidence_sha256: hash64('e'),
      evidence_class: 'internal' };
    const r = await app.inject({ method: 'POST', url: '/v1/subjects/merge',
      headers: bearer(k.operator), payload });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, 'insufficient_authority');

    const named = await app.inject({ method: 'POST', url: '/v1/subjects/merge',
      headers: bearer(k.principal), payload: { ...payload, subject_ids: ['sub_a', 'sub_b'] } });
    assert.equal(named.statusCode, 400,
      'a caller that could name subjects could union two it never demonstrated a link to');
  });
});

describe('scopes are enforced at the route', () => {
  test('the quickstart key cannot claw or read insight', async () => {
    const k = await keys();
    for (const [method, url, payload] of [
      ['POST', '/v1/seals/seal_x/claw', { evidence_sha256: hash64('e'), evidence_class: 'internal' }],
      ['GET', '/v1/insight/quadrant', undefined],
      ['POST', '/v1/keys', { authority: 'agent', scopes: ['seals:write'], label: 'x' }],
      ['POST', '/v1/cohorts', { cohort: 'region' }],
      ['POST', '/v1/subjects/merge',
        { aliases: person('sm'), evidence_sha256: hash64('e'), evidence_class: 'internal' }],
      ['POST', '/v1/subjects/carve-out',
        { alias: { type: 'card_fp', value: 'x' },
          evidence_sha256: hash64('e'), evidence_class: 'internal' }],
      ['POST', '/v1/cohorts/placements',
        { aliases: person('sc'), cohort: 'region', band: 'north' }],
    ] as const) {
      const r = await app.inject({ method, url, headers: bearer(k.narrow),
        ...(payload ? { payload } : {}) });
      assert.equal(r.statusCode, 403, `${method} ${url}`);
      assert.equal(r.json().error.code, 'forbidden');
    }
  });

  test('a key may always revoke itself, even without keys:mint', async () => {
    const k = await keys();
    const ws = k.ws;
    const self = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'selfrevoke', by: null });

    const r = await app.inject({ method: 'DELETE', url: `/v1/keys/${self.id}`,
      headers: bearer(self.key) });
    assert.equal(r.statusCode, 204,
      'a leaked key must be retirable by whatever noticed the leak');

    const after = await app.inject({ method: 'POST', url: '/v1/determinations/lookup',
      headers: bearer(self.key), payload: { aliases: person('x'), scope: 'refund' } });
    assert.equal(after.statusCode, 401);
  });
});

describe('the measurements over HTTP', () => {
  test('quadrant and sources are workspace-scoped and snake_case', async () => {
    const k = await keys();
    await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent), payload: { aliases: person('m1'), facts: FACTS() } });
    await app.inject({ method: 'POST', url: '/v1/seals', headers: bearer(k.agent),
      payload: { idempotency_key: 'idem-m1', aliases: person('m1'), scope: 'refund', disposition: 'bind',
        rule: RULE, claw: CLAW } });

    const q = await app.inject({ method: 'GET', url: '/v1/insight/quadrant',
      headers: bearer(k.operator) });
    assert.equal(q.statusCode, 200);
    assert.equal(q.json().examined, 1);
    assert.equal(q.json().wrong_and_resisted, 0);
    assert.ok('quiet_error' in q.json());

    const s = await app.inject({ method: 'GET', url: '/v1/insight/sources?days=30',
      headers: bearer(k.operator) });
    assert.equal(s.statusCode, 200);
    const carrier = s.json().sources.find((x: { source: string }) => x.source === 'carrier_api');
    assert.equal(carrier.lapse_rate, null, 'below the volume floor');
    assert.ok(carrier.note.includes('volume floor'));
  });

  test('a window is parsed from the string the wire actually carries', async () => {
    const k = await keys();
    const ok = await app.inject({ method: 'GET', url: '/v1/insight/quadrant?days=7',
      headers: bearer(k.operator) });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().window.days, 7, 'coerced deliberately, at the edge, not globally');
  });

  test('an out-of-range or non-numeric window is refused with a readable message', async () => {
    const k = await keys();
    for (const q of ['days=9999', 'days=0', 'days=abc', 'days=-1', 'days=1.5']) {
      const r = await app.inject({ method: 'GET', url: `/v1/insight/sources?${q}`,
        headers: bearer(k.operator) });
      assert.equal(r.statusCode, 400, q);
      assert.equal(r.json().error.code, 'invalid_request');
    }
  });

  test('a JSON body is still NOT coerced — strictness stays where it belongs', async () => {
    const k = await keys();
    const r = await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.agent),
      payload: { aliases: person('coerce'), facts: [
        { fact: 'prior_refunds_90d', type: 'int', value: '3', source: 'core_ledger' }] } });
    assert.equal(r.statusCode, 400,
      'a string "3" where an integer was declared is a caller bug, not something to guess at');
  });
});
