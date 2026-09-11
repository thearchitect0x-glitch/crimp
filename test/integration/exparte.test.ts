// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-07 · Ex parte first. A procedural termination cannot be recorded while
 * the merits can be decided from facts already on file — from any programme.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { declareRuleset, commitRule, closeRule } from '../../src/domain/registry.js';
import { catalogueFact } from '../../src/domain/catalogue.js';
import { declareSource, listSources } from '../../src/domain/sources.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const DELIVERY = 'notice.renewal.delivered_status';
const PROCEDURAL = { fact: 'renewal.returned', op: 'eq', value: false };
const SUBSTANTIVE = { fact: 'household.income', op: 'gt', value: 2000 };
const CITE = '42 CFR 435.916(b)';

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<ApiError> {
  let caught: ApiError | undefined;
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why); caught = e; return true;
  }, why);
  return caught!;
}

/** Medicaid's renewal programme, with SNAP's case system declared as a source. */
async function programme(A: Actors, opts: { exParte?: boolean } = { exParte: true }): Promise<void> {
  await catalogueFact(A.operator, { fact: DELIVERY, factType: 'str', class: 'delivery' });
  await catalogueFact(A.operator, { fact: 'renewal.returned', factType: 'bool', class: 'non_response', guardedBy: DELIVERY });
  await catalogueFact(A.operator, { fact: 'household.income', factType: 'int', class: 'plain' });
  await declareSource(A.operator, { source: 'snap_case', admissibility: 'internal', programme: 'snap' });
  await declareRuleset(A.operator, { ruleset: 'medicaid', exParteRule: opts.exParte ? 'renewal.income' : null });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.income', rule: SUBSTANTIVE,
    legalAuthority: CITE, effectiveFrom: new Date('2026-01-01') });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.procedural', rule: PROCEDURAL,
    legalAuthority: CITE, effectiveFrom: new Date('2026-01-01') });
}
async function nonResponse(A: Actors, tag: string): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'renewal.returned', type: 'bool', value: false, source: 'state_registry' },
    { fact: DELIVERY, type: 'str', value: 'delivered', source: 'state_registry' },
  ] }, STRENGTHS);
}
const procedural = (tag: string) => ({
  idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'medicaid.renewal', disposition: 'bind' as const,
  ruleRef: { ruleset: 'medicaid', ruleId: 'renewal.procedural' }, claw: CLAW,
});

describe('a procedural termination', () => {
  test('is blocked when SNAP\'s income fact decides Medicaid\'s substantive rule — and the refusal names the fact and its programme', async () => {
    const A = await actors();
    await programme(A);
    await nonResponse(A, 'x1');
    await attest(A.agent, { aliases: person('x1'), facts: [
      { fact: 'household.income', type: 'int', value: 3000, source: 'snap_case' } ] }, STRENGTHS);
    const e = await refuses(() => seal(A.agent, procedural('x1'), STRENGTHS),
      'cross_program_fact_available', 'the merits were decidable');
    const d = e.detail as { rule_id: string; outcome: string;
      facts: Array<{ fact: string; source: string; programme: string | null; asserted_at: string }> };
    assert.equal(d.rule_id, 'renewal.income');
    assert.equal(d.outcome, 'true');
    assert.equal(d.facts.length, 1);
    assert.deepEqual({ fact: d.facts[0]!.fact, source: d.facts[0]!.source, programme: d.facts[0]!.programme },
      { fact: 'household.income', source: 'snap_case', programme: 'snap' });
    assert.match(d.facts[0]!.asserted_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(e.message, /435\.916\(b\)\(1\)/);
  });

  test('proceeds when the merits are NOT decidable, and the attempt is on the record', async () => {
    const A = await actors();
    await programme(A);
    await nonResponse(A, 'x2');
    const out = await seal(A.agent, procedural('x2'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    const { rows } = await getPool().query<{ detail: { ex_parte: Record<string, unknown> } }>(
      `SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'sealed'`, [out.sealId]);
    assert.deepEqual(rows[0]?.detail.ex_parte, { ruleset: 'medicaid', rule_id: 'renewal.income',
      version: rows[0]?.detail.ex_parte['version'], outcome: 'unknown', missing: ['household.income'] });
  });

  test('is blocked whichever way the merits come out — a substantive denial is still a decision on the merits', async () => {
    const A = await actors();
    await programme(A);
    await nonResponse(A, 'x3');
    await attest(A.agent, { aliases: person('x3'), facts: [
      { fact: 'household.income', type: 'int', value: 500, source: 'snap_case' } ] }, STRENGTHS);
    const e = await refuses(() => seal(A.agent, procedural('x3'), STRENGTHS),
      'cross_program_fact_available', 'income below the line still decides it');
    assert.equal((e.detail as { outcome: string }).outcome, 'false');
  });

  test('must be made under a committed rule, so the programme\'s ex parte rule can be tried', async () => {
    const A = await actors();
    await programme(A);
    await nonResponse(A, 'x4');
    await refuses(() => seal(A.agent, { ...procedural('x4'), ruleRef: null, rule: PROCEDURAL }, STRENGTHS),
      'procedural_needs_registry', 'an inline procedural rule');
  });

  test('a programme that declared an ex parte rule must keep one in force', async () => {
    const A = await actors();
    await programme(A);
    await nonResponse(A, 'x5');
    const { rows } = await getPool().query<{ version: string }>(
      `SELECT version FROM rules WHERE workspace_id = $1 AND rule_id = 'renewal.income'`, [A.ws]);
    await closeRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.income', version: rows[0]!.version,
      effectiveTo: new Date('2026-06-01') });
    await refuses(() => seal(A.agent, { ...procedural('x5'), asOf: new Date('2026-08-01') }, STRENGTHS),
      'ex_parte_rule_not_in_force', 'the ex parte rule was closed');
  });

  test('a programme that has not said how it decides on the merits is not blocked — and the record says so', async () => {
    const A = await actors();
    await programme(A, { exParte: false });
    await nonResponse(A, 'x6');
    await attest(A.agent, { aliases: person('x6'), facts: [
      { fact: 'household.income', type: 'int', value: 3000, source: 'snap_case' } ] }, STRENGTHS);
    const out = await seal(A.agent, procedural('x6'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    const { rows } = await getPool().query<{ detail: { ex_parte: Record<string, unknown> } }>(
      `SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'sealed'`, [out.sealId]);
    assert.equal(rows[0]?.detail.ex_parte['outcome'], 'not_declared');
  });

  test('a substantive rule is not procedural and is untouched by any of this', async () => {
    const A = await actors();
    await programme(A);
    await attest(A.agent, { aliases: person('x7'), facts: [
      { fact: 'household.income', type: 'int', value: 3000, source: 'snap_case' } ] }, STRENGTHS);
    const out = await seal(A.agent, { ...procedural('x7'), ruleRef: { ruleset: 'medicaid', ruleId: 'renewal.income' } }, STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    const { rows } = await getPool().query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'sealed'`, [out.sealId]);
    assert.equal('ex_parte' in rows[0]!.detail, false);
  });
});

describe('a declared source', () => {
  test('carries its programme, keeps its class, and is an operator act', async () => {
    const A = await actors();
    await refuses(() => declareSource(A.agent, { source: 'x', admissibility: 'internal' }),
      'insufficient_authority', 'an agent promoting a feed');
    const s = await declareSource(A.operator, { source: 'snap_case', admissibility: 'internal', programme: 'snap' });
    assert.equal(s.programme, 'snap');
    await refuses(() => declareSource(A.operator, { source: 'snap_case', admissibility: 'authority' }),
      'source_class_fixed', 'changing a class');
    const again = await declareSource(A.operator, { source: 'snap_case', admissibility: 'internal', programme: 'snap_ebt' });
    assert.equal(again.programme, 'snap_ebt', 'the programme may be corrected');
    assert.ok((await listSources(A.operator)).some((x) => x.source === 'snap_case'));
  });
});
