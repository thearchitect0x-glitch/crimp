// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Prior authorization, end to end, on the real configuration: an
 * authorization, a denial with its remedy, a procedural denial behind the
 * delivery guard, an expedited request on its 72-hour clock, authorization
 * units as a permit with uses, and the notice. Plus the three findings,
 * asserted so that fixing one is a visible act — and the first of them
 * fixed here: an appeal is contestation.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, exercise } from '../../src/domain/seal.js';
import { startClock, advanceClocks, clocksFor } from '../../src/domain/clocks.js';
import { noticeFor } from '../../src/domain/notice.js';
import { validateRule, LIMITS } from '../../src/domain/rule.js';
import { quadrant, quietErrorEstimate } from '../../src/domain/insight.js';
import { recordAppeal } from '../../src/domain/appeal.js';
import { seedPriorAuth, PRIOR_AUTH_RULES, PRIOR_AUTH } from '../../src/programmes/prior_auth.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, type Actors } from '../helpers.js';
import { loadStrengths } from '../../src/domain/strengths.js';

const person = (tag: string) => [{ type: 'member_id', value: `m-${tag}` }, { type: 'mbi', value: `mbi-${tag}` }];
const CLAW = { authority: 'operator' as const, evidenceFloor: 'internal' as const, coolingOffSeconds: 0 };
type F = [string, 'bool' | 'int' | 'str', boolean | number | string];

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function request(A: Actors, tag: string, facts: F[], source = 'utilization_management'): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: facts.map(([fact, type, value]) => ({ fact, type, value, source })) }, await loadStrengths(A.ws));
}
const under = (tag: string, ruleId: string, disposition: 'bind' | 'permit', extra: Record<string, unknown> = {}) => ({
  idempotencyKey: `idem-${tag}-${ruleId}`, aliases: person(tag), scope: 'prior_auth.request', disposition,
  ruleRef: { ruleset: 'prior_auth', ruleId }, claw: CLAW, ...extra,
});
/** A standard lumbar MRI request with everything on file. */
const BASE: F[] = [
  ['request.service', 'str', 'lumbar_mri'], ['request.urgency', 'str', 'standard'],
  ['member.enrolled', 'bool', true], ['member.plan', 'str', 'medicaid_mco'], ['provider.in_network', 'bool', true],
  ['clinical.red_flag', 'bool', false], ['clinical.neuro_deficit', 'bool', false],
  ['clinical.symptom_duration_weeks', 'int', 8], ['clinical.conservative_therapy_weeks', 'int', 8],
  ['clinical.prior_imaging_months', 'int', 30], ['clinical.jeopardy_attested', 'bool', false],
];

describe('the prior-authorization configuration', () => {
  test('applies idempotently, every rule inside the grammar\'s limits, every criterion a literal with a citation', async () => {
    const A = await actors();
    const first = await seedPriorAuth(A.operator);
    assert.equal(first.committed, PRIOR_AUTH_RULES.length);
    const second = await seedPriorAuth(A.operator);
    assert.equal(second.committed, 0);
    assert.equal(second.alreadyCommitted, PRIOR_AUTH_RULES.length);
    for (const r of PRIOR_AUTH_RULES) {
      const facts = validateRule(r.rule);
      assert.ok(facts.size <= LIMITS.maxNodes, r.ruleId);
      assert.match(r.legalAuthority, /CFR/);
      assert.ok(r.note.length > 40, r.ruleId);
    }
  });

  test('a request meeting the criteria is authorised, and no denial rule applies', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'ok', BASE);
    const grant = await seal(A.agent, under('ok', 'lumbar_mri.necessary', 'permit'), await loadStrengths(A.ws));
    assert.equal(grant.outcome, 'sealed');
    assert.equal(grant.ruleRef?.legalAuthority, '42 CFR 422.101(b)(6); 42 CFR 438.210(a)(5)');
    for (const id of ['lumbar_mri.not_necessary', 'lumbar_mri.duplicate']) {
      assert.equal((await seal(A.agent, under('ok', id, 'bind'), await loadStrengths(A.ws))).outcome, 'not_applicable', id);
    }
  });

  test('three weeks of conservative therapy is denied, and the remedy names a fact only time can change (finding 2)', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'early', BASE.map((f) => (f[0] === 'clinical.conservative_therapy_weeks' ? ['clinical.conservative_therapy_weeks', 'int', 3] as F : f)));
    const out = await seal(A.agent, under('early', 'lumbar_mri.not_necessary', 'bind'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    const named = new Set(out.reasons.map((r) => r.fact));
    assert.ok(named.has('clinical.conservative_therapy_weeks'), 'the reason is the therapy criterion');
    assert.ok(!named.has('clinical.symptom_duration_weeks'), 'eight weeks of symptoms is not offered as a reason for refusal');
    // The remedy: what would change it. Weeks of therapy, weeks of symptoms, a red flag, a deficit —
    // three of which a person cannot bring about by any act, and one of which only time brings.
    const sets = out.remedy!.sets.map((s) => s.map((c) => c.fact).sort().join('+'));
    assert.ok(sets.some((s) => s === 'clinical.conservative_therapy_weeks'), sets.join(' | '));
    const therapy = out.remedy!.sets.find((s) => s.length === 1 && s[0]!.fact === 'clinical.conservative_therapy_weeks')!;
    assert.deepEqual(therapy[0]!.constraints.map((c) => [c.op, c.value, c.truth]), [['lt', PRIOR_AUTH.conservativeTherapyWeeks, 'false']]);
  });

  test('a procedural denial waits on the request for information reaching the provider', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'proc', BASE);
    await request(A, 'proc', [['provider.additional_info_returned', 'bool', false]]);
    await request(A, 'proc', [['notice.additional_info.delivered_status', 'str', 'returned']], 'mail_vendor');
    // The guard withholds the non-response fact; the rule is UNKNOWN; the gate refuses to seal at all.
    await assert.rejects(async () => seal(A.agent, under('proc', 'procedural.information_not_returned', 'bind'), await loadStrengths(A.ws)),
      (e: unknown) => e instanceof ApiError && e.code === 'facts_not_attested'
        && JSON.stringify(e.detail).includes('delivery_unattested'), 'a denial cannot rest on a request nobody received');
    await request(A, 'proc', [['notice.additional_info.delivered_status', 'str', 'delivered']], 'mail_vendor');
    const out = await seal(A.agent, under('proc', 'procedural.information_not_returned', 'bind'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    // No ex parte rule in prior authorization, and the record says so.
    const { rows } = await getPool().query<{ detail: { ex_parte?: { outcome: string } } }>(
      `SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'sealed'`, [out.sealId]);
    assert.equal(rows[0]?.detail.ex_parte?.outcome, 'not_declared');
  });

  test('an expedited request is decided on the 72-hour clock, and the decision meets it', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'fast', BASE.map((f) => (f[0] === 'request.urgency' ? ['request.urgency', 'str', 'expedited'] as F : f)));
    await request(A, 'fast', [['clinical.jeopardy_attested', 'bool', true]], 'provider_portal');
    await startClock(A.agent, { aliases: person('fast'), scope: 'prior_auth.request', clock: 'prior_auth_expedited_72_hour',
      startedAt: new Date(Date.now() - 3_600_000) }, await loadStrengths(A.ws));
    const out = await seal(A.agent, under('fast', 'expedited.required', 'permit'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    await advanceClocks(A.ws);
    const [c] = await clocksFor(A.agent, { aliases: person('fast') }, await loadStrengths(A.ws));
    assert.equal(c?.status, 'met');
  });

  test('authorization units are a permit with uses: twelve visits, and the thirteenth is refused', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'pt', BASE.map((f) => (f[0] === 'clinical.red_flag' ? ['clinical.red_flag', 'bool', true] as F : f)));
    const out = await seal(A.agent, under('pt', 'lumbar_mri.necessary', 'permit', { maxUses: 12 }), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    for (let i = 0; i < 12; i++) assert.equal((await exercise(A.agent, { sealId: out.sealId! })).exercised, true, `use ${i + 1}`);
    const thirteenth = await exercise(A.agent, { sealId: out.sealId! });
    assert.equal(thirteenth.exercised, false);
    assert.equal(thirteenth.remaining, 0);
  });

  test('resistance arrives as an appeal, and the quadrant now sees it (finding 1, fixed)', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'apl', BASE.map((f) => (f[0] === 'clinical.conservative_therapy_weeks' ? ['clinical.conservative_therapy_weeks', 'int', 2] as F : f)));
    const out = await seal(A.agent, under('apl', 'lumbar_mri.not_necessary', 'bind'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    // Nobody comes back through the gate. Before: normal, uncontested.
    let q = await quadrant(getPool(), A.ws, 90);
    assert.equal(q.contestedAndCorrect, 0);
    // The provider files a reconsideration. That is the contestation this domain has.
    const filed = await recordAppeal(A.agent, { sealId: out.sealId!, channel: 'provider', reference: 'RECON-2026-0001' });
    assert.equal(filed.sealId, out.sealId);
    q = await quadrant(getPool(), A.ws, 90);
    assert.equal(q.contestedAndCorrect, 1, 'an appeal is contestation');
    assert.equal(q.appealed, 1);
    assert.equal(q.attempts.some.examined, 1);
    // Then the records arrive from the EHR: a red flag the request had not carried. The denial lapses at the write.
    await request(A, 'apl', [['clinical.red_flag', 'bool', true]], 'ehr_records');
    q = await quadrant(getPool(), A.ws, 90);
    assert.equal(q.wrongAndResisted, 1, 'wrong, and resisted through the appeal');
    const e = await quietErrorEstimate(getPool(), A.ws, 90, { minFoughtLapses: 1 });
    assert.equal(e.fought.lapsed, 1);
    assert.equal(e.fought.lapsedViaFeed, 1, 'discovered through the records feed, not the appeal itself');
    // An appeal contests a refusal; a grant cannot be appealed here.
    await request(A, 'grant', BASE.map((f) => (f[0] === 'clinical.red_flag' ? ['clinical.red_flag', 'bool', true] as F : f)));
    const g = await seal(A.agent, under('grant', 'lumbar_mri.necessary', 'permit'), await loadStrengths(A.ws));
    await assert.rejects(() => recordAppeal(A.agent, { sealId: g.sealId!, channel: 'member' }),
      (err: unknown) => err instanceof ApiError && err.code === 'not_adverse');
  });

  test('the notice reads as prior authorization: the criterion, the citation, the appeal window', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'ntc', BASE.map((f) => (f[0] === 'clinical.conservative_therapy_weeks' ? ['clinical.conservative_therapy_weeks', 'int', 1] as F : f)));
    const out = await seal(A.agent, under('ntc', 'lumbar_mri.not_necessary', 'bind'), await loadStrengths(A.ws));
    const n = await noticeFor(A.operator, out.sealId!);
    assert.match(n.text, /conservative therapy/i);
    assert.match(n.text, /42 CFR 422\.101\(b\)\(6\)/);
    assert.equal(n.notice.appeal.programme, 'Prior authorization');
    assert.equal(n.notice.appeal.days, 60);
  });

  test('the derived facts are committed as numbers, and the record says nothing about how (finding 3)', async () => {
    const A = await actors(); await seedPriorAuth(A.operator);
    await request(A, 'dup', BASE.map((f) => (f[0] === 'clinical.prior_imaging_months' ? ['clinical.prior_imaging_months', 'int', 4] as F : f)), 'claims_history');
    const out = await seal(A.agent, under('dup', 'lumbar_mri.duplicate', 'bind'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    const { rows } = await getPool().query<{ fact: string; source: string }>(
      'SELECT fact, source FROM seal_facts WHERE seal_id = $1 AND fact = $2', [out.sealId, 'clinical.prior_imaging_months']);
    assert.equal(rows[0]?.source, 'claims_history', 'the source is the engine; the derivation is not on the record');
  });
});
