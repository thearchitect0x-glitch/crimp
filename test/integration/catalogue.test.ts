// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-01 · Delivery before non-response.
 *
 * The brief's four conformance cases, plus what the brief did not ask for
 * and the design needs: that the guard holds on re-evaluation, that a
 * non-response fact which did not decide the outcome does not block it,
 * and that the attester is on the record.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, reevaluate } from '../../src/domain/seal.js';
import { proof } from '../../src/domain/record.js';
import { declareRuleset, commitRule } from '../../src/domain/registry.js';
import { catalogueFact, listCatalogue, applyGuards, DELIVERED_STATUS } from '../../src/domain/catalogue.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, stateOf, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
// A procedural termination: "the renewal was not returned".
const NON_RESPONSE = { fact: 'renewal.returned', op: 'eq', value: false };
const DELIVERY = 'notice.renewal.delivered_status';

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<ApiError> {
  let caught: ApiError | undefined;
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    caught = e; return true;
  }, why);
  return caught!;
}

/**
 * The data dictionary a renewal programme would declare — and, since cap-07,
 * the committed rules: a rule resting on a non-response fact is a procedural
 * determination, and a procedural determination must be committed policy so
 * the programme's ex parte rule can be tried first. This programme declares
 * no ex parte rule, so the guard is what is under test here.
 */
async function programme(A: Actors): Promise<void> {
  await catalogueFact(A.operator, { fact: DELIVERY, factType: 'str', class: 'delivery' });
  await catalogueFact(A.operator, { fact: 'renewal.returned', factType: 'bool',
    class: 'non_response', guardedBy: DELIVERY });
  await catalogueFact(A.operator, { fact: 'household.income', factType: 'int', class: 'plain' });
  await declareRuleset(A.operator, { ruleset: 'medicaid' });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.procedural', rule: NON_RESPONSE,
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.either',
    rule: { any: [NON_RESPONSE, { fact: 'household.income', op: 'gt', value: 999_999 }] },
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
}

const bind = (tag: string, rule: unknown, scope = 'medicaid.renewal') => ({
  idempotencyKey: `idem-${tag}`, aliases: person(tag), scope,
  disposition: 'bind' as const, rule, claw: CLAW,
});
/** A procedural determination, under the committed rule. */
const procedural = (tag: string, ruleId = 'renewal.procedural', scope = 'medicaid.renewal') => ({
  idempotencyKey: `idem-${tag}`, aliases: person(tag), scope,
  disposition: 'bind' as const, ruleRef: { ruleset: 'medicaid', ruleId }, claw: CLAW,
});

async function say(A: Actors, tag: string, facts: Array<[string, 'bool' | 'int' | 'str', boolean | number | string]>): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: facts.map(([fact, type, value]) => ({
    fact, type, value, source: 'state_registry' })) }, STRENGTHS);
}

/* ── The brief's four cases ──────────────────────────────────────────── */

describe('a finding of non-response needs delivery first', () => {
  test('(a) non-response + delivered → evaluates and seals', async () => {
    const A = await actors();
    await programme(A);
    await say(A, 'a1', [['renewal.returned', 'bool', false], [DELIVERY, 'str', 'delivered']]);
    const out = await seal(A.agent, procedural('a1'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
  });

  test('(b) non-response + returned mail → unknown, reason delivery_unattested', async () => {
    const A = await actors();
    await programme(A);
    await say(A, 'b1', [['renewal.returned', 'bool', false], [DELIVERY, 'str', 'returned']]);
    const e = await refuses(() => seal(A.agent, procedural('b1'), STRENGTHS),
      'facts_not_attested', 'returned mail');
    const d = e.detail as { missing: string[]; guarded: Array<Record<string, unknown>> };
    assert.deepEqual(d.missing, ['renewal.returned']);
    assert.deepEqual(d.guarded, [{ fact: 'renewal.returned', guardedBy: DELIVERY,
      requires: 'delivered', observed: 'returned', reason: 'delivery_unattested' }]);
    assert.match(e.message, /delivery is attested/);
  });

  test('(c) non-response + no delivery fact at all → unknown, reason delivery_unattested', async () => {
    const A = await actors();
    await programme(A);
    await say(A, 'c1', [['renewal.returned', 'bool', false]]);
    const e = await refuses(() => seal(A.agent, procedural('c1'), STRENGTHS),
      'facts_not_attested', 'no delivery fact');
    const d = e.detail as { guarded: Array<{ observed: unknown; reason: string }> };
    assert.equal(d.guarded[0]?.observed, null);
    assert.equal(d.guarded[0]?.reason, 'delivery_unattested');
  });

  test('(d) a synonym cannot be committed, sealed inline, or attested', async () => {
    const A = await actors();
    await programme(A);
    const synonym = { fact: 'renewal_packet_recv', op: 'eq', value: false };
    const e = await refuses(() => commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.synonym',
      rule: synonym, legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') }),
    'uncatalogued_fact', 'committing a synonym');
    assert.deepEqual((e.detail as { uncatalogued: string[] }).uncatalogued, ['renewal_packet_recv']);
    await refuses(() => seal(A.agent, bind('d1', synonym), STRENGTHS),
      'uncatalogued_fact', 'sealing a synonym inline');
    await refuses(() => say(A, 'd1', [['renewal_packet_recv', 'bool', false]]),
      'uncatalogued_fact', 'attesting a synonym');
    // The legitimate rule is committed already, because its fact is catalogued — and guarded.
    const ok = await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.procedural',
      rule: NON_RESPONSE, legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
    assert.equal(ok.outcome, 'already_committed');
  });
});

/* ── What the brief did not ask for and the design needs ────────────── */

describe('the guard', () => {
  test('holds on re-evaluation: a determination made on delivered mail lapses into unknown when the mail comes back', async () => {
    const A = await actors();
    await programme(A);
    await say(A, 'g1', [['renewal.returned', 'bool', false], [DELIVERY, 'str', 'delivered']]);
    const out = await seal(A.agent, procedural('g1'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');

    // NCOA comes back: the notice never reached them.
    await say(A, 'g1', [[DELIVERY, 'str', 'returned']]);
    await reevaluate(A.ws);
    assert.equal(await stateOf(out.sealId!), 'tainted');
    const { rows } = await getPool().query<{ detail: { guarded?: Array<{ fact: string }> } }>(
      `SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'tainted'`, [out.sealId]);
    assert.equal(rows[0]?.detail.guarded?.[0]?.fact, 'renewal.returned',
      'the taint says why: the guard no longer holds');

    // Delivery re-established (a second notice, delivered): the finding stands again.
    await say(A, 'g1', [[DELIVERY, 'str', 'delivered']]);
    await reevaluate(A.ws);
    assert.equal(await stateOf(out.sealId!), 'sealed');
  });

  test('withholds only what it guards: a non-response fact that did not decide the outcome does not block it', async () => {
    const A = await actors();
    await programme(A);
    // Income alone carries this rule; the non-response branch is not needed.
    await say(A, 'w1', [['renewal.returned', 'bool', false], ['household.income', 'int', 2_000_000]]);
    const out = await seal(A.agent, procedural('w1', 'renewal.either'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    // And the record commits only to what the evaluator read.
    const rec = await proof(A.operator, out.sealId!);
    assert.deepEqual(rec.facts.map((f) => f.fact), ['household.income']);
    assert.deepEqual(rec.reasons.map((r) => r.fact), ['household.income']);
  });

  test('is pure and says what it withheld', () => {
    const catalogue = new Map([
      ['nr', { fact: 'nr', factType: 'bool' as const, class: 'non_response' as const,
        guardedBy: 'dl', guardValue: 'delivered', allowedValues: null, description: null,
        declaredBy: 'operator', declaredAt: new Date() }],
    ]);
    const facts = { nr: { type: 'bool' as const, value: false }, x: { type: 'int' as const, value: 1 } };
    const r = applyGuards(catalogue, facts, ['nr', 'x']);
    assert.deepEqual(Object.keys(r.facts), ['x']);
    assert.equal(r.withheld[0]?.observed, null);
    assert.deepEqual(facts.nr, { type: 'bool', value: false }, 'the input is not mutated');
    const held = applyGuards(catalogue, { ...facts, dl: { type: 'str', value: 'delivered' } }, ['nr', 'x']);
    assert.deepEqual(Object.keys(held.facts).sort(), ['dl', 'nr', 'x']);
    assert.deepEqual(held.withheld, []);
  });
});

describe('the catalogue', () => {
  test('cannot hold a non-response fact without a delivery guard', async () => {
    const A = await actors();
    await refuses(() => catalogueFact(A.operator, { fact: 'renewal.returned', factType: 'bool',
      class: 'non_response' }), 'guard_required', 'no guard');
    await catalogueFact(A.operator, { fact: 'household.income', factType: 'int', class: 'plain' });
    await refuses(() => catalogueFact(A.operator, { fact: 'renewal.returned', factType: 'bool',
      class: 'non_response', guardedBy: 'household.income' }), 'guard_not_delivery', 'guard is not delivery');
    await refuses(() => catalogueFact(A.operator, { fact: DELIVERY, factType: 'bool',
      class: 'delivery' }), 'invalid_request', 'delivery must be str');
    await refuses(() => catalogueFact(A.operator, { fact: 'household.income', factType: 'plain' as never,
      class: 'plain', guardedBy: 'x' }), 'invalid_request', 'a plain fact with a guard');
  });

  test('is an operator act, fixes a fact\'s type, and closes the values a delivery fact may carry', async () => {
    const A = await actors();
    await refuses(() => catalogueFact(A.agent, { fact: 'x', factType: 'int', class: 'plain' }),
      'insufficient_authority', 'agent declaring a fact');
    await programme(A);
    await refuses(() => catalogueFact(A.operator, { fact: 'household.income', factType: 'str',
      class: 'plain' }), 'catalogue_type_fixed', 'changing a type');
    await refuses(() => say(A, 't1', [['household.income', 'str', 'lots']]),
      'catalogue_type_mismatch', 'attesting the wrong type');
    await refuses(() => say(A, 't1', [[DELIVERY, 'str', 'lost']]),
      'value_not_allowed', 'a delivery status outside the closed set');
    const entries = await listCatalogue(A.operator);
    assert.deepEqual(entries.find((e) => e.fact === DELIVERY)?.allowedValues, [...DELIVERED_STATUS].sort());
    assert.equal(entries.find((e) => e.fact === 'renewal.returned')?.guardValue, 'delivered');
  });

  test('records the attester on every fact, and the record carries it', async () => {
    const A = await actors();
    await programme(A);
    await say(A, 'at1', [['household.income', 'int', 100]]);
    const { rows } = await getPool().query<{ attester: string }>(
      `SELECT attester FROM attestations WHERE workspace_id = $1 AND fact = 'household.income'`, [A.ws]);
    assert.equal(rows[0]?.attester, A.agent.keyId);
    const out = await seal(A.agent, bind('at1', { fact: 'household.income', op: 'lt', value: 200 }), STRENGTHS);
    const rec = await proof(A.operator, out.sealId!);
    assert.equal(rec.facts[0]?.attester, A.agent.keyId);
  });

  test('an open workspace — no catalogue — behaves exactly as before', async () => {
    const A = await actors();
    await say(A, 'o1', [['anything.at_all', 'bool', true]]);
    const out = await seal(A.agent, bind('o1', { fact: 'anything.at_all', op: 'eq', value: true }), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    const rec = await proof(A.operator, out.sealId!);
    assert.equal(rec.facts[0]?.attester, A.agent.keyId, 'the attester is recorded regardless');
  });
});
