// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * SNAP, end to end, on the real configuration: a grant, a denial with its
 * remedy, a procedural denial behind the NOMI guard, expedited service on
 * its clock, the work requirement across the H.R. 1 change, and the notice.
 * Plus the four findings, asserted so that fixing one is a visible act.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { startClock, advanceClocks, clocksFor } from '../../src/domain/clocks.js';
import { noticeFor } from '../../src/domain/notice.js';
import { validateRule, LIMITS } from '../../src/domain/rule.js';
import { seedSnap, SNAP_RULES, SNAP_FY2026, limitFor } from '../../src/programmes/snap.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, type Actors } from '../helpers.js';
import { loadStrengths } from '../../src/domain/strengths.js';
import type { Principal } from '../../src/domain/auth.js';

const person = (tag: string) => [{ type: 'ssn', value: `ssn-${tag}` }, { type: 'case_id', value: `case-${tag}` }];
const CLAW = { authority: 'operator' as const, evidenceFloor: 'internal' as const, coolingOffSeconds: 0 };
type F = [string, 'bool' | 'int' | 'str', boolean | number | string];

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function household(A: Actors, tag: string, facts: F[], source = 'snap_case_system'): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: facts.map(([fact, type, value]) => ({ fact, type, value, source })) }, await loadStrengths(A.ws));
}
const under = (tag: string, ruleId: string, disposition: 'bind' | 'permit', extra: Record<string, unknown> = {}) => ({
  idempotencyKey: `idem-${tag}-${ruleId}`, aliases: person(tag), scope: 'snap.certification', disposition,
  ruleRef: { ruleset: 'snap', ruleId }, claw: CLAW, ...extra,
});
/** A four-person household with everything verified and every test met. */
const ELIGIBLE: F[] = [
  ['hh.size', 'int', 4], ['hh.elderly_or_disabled', 'bool', false], ['hh.categorically_eligible', 'bool', false],
  ['income.gross_monthly', 'int', 3000], ['income.net_monthly', 'int', 2000],
  ['income.gross_pct_fpl', 'int', 112], ['income.net_pct_fpl', 'int', 75],
  ['resources.countable', 'int', 1000],
  ['identity.verified', 'bool', true], ['residency.verified', 'bool', true], ['status.verified', 'bool', true],
];

async function programme(): Promise<Actors & { p: Principal }> {
  const A = await actors();
  await seedSnap(A.operator);
  return { ...A, p: A.operator };
}

describe('the SNAP configuration', () => {
  test('applies idempotently, every rule inside the grammar\'s limits, every threshold a literal with a citation', async () => {
    const A = await actors();
    const first = await seedSnap(A.operator);
    assert.equal(first.committed, SNAP_RULES.length);
    const again = await seedSnap(A.operator);
    assert.equal(again.committed, 0);
    assert.equal(again.alreadyCommitted, SNAP_RULES.length);
    for (const r of SNAP_RULES) {
      const facts = validateRule(r.rule);
      assert.ok(facts.size > 0, r.ruleId);
      assert.match(r.legalAuthority, /7 CFR 273/);
    }
    // The enumerated income test is the biggest rule in the set: 40 nodes of 64.
    const gross = SNAP_RULES.find((r) => r.ruleId === 'cert.gross_income')!.rule;
    const count = (n: unknown): number => Array.isArray(n) ? n.reduce((a: number, k) => a + count(k), 0)
      : typeof n === 'object' && n !== null ? 1 + Object.values(n).filter((v) => typeof v === 'object').reduce((a: number, k) => a + count(k), 0) : 0;
    assert.equal(count(gross), 40);
    assert.ok(count(gross) <= LIMITS.maxNodes);
    assert.equal(limitFor(SNAP_FY2026.grossLimit, SNAP_FY2026.grossEachAdditional, 4), 3483);
    assert.equal(limitFor(SNAP_FY2026.grossLimit, SNAP_FY2026.grossEachAdditional, 10), 5867 + 2 * 596);
  });

  test('a household that meets every test is granted, and no denial rule applies', async () => {
    const A = await programme();
    await household(A, 'ok', ELIGIBLE);
    const grant = await seal(A.agent, under('ok', 'cert.eligible', 'permit'), await loadStrengths(A.ws));
    assert.equal(grant.outcome, 'sealed');
    assert.equal(grant.ruleRef?.legalAuthority, '7 CFR 273.9(a); 7 CFR 273.8(b); 7 CFR 273.2(f)(1)');
    for (const id of ['cert.gross_income', 'cert.net_income', 'cert.resources']) {
      assert.equal((await seal(A.agent, under('ok', id, 'bind'), await loadStrengths(A.ws))).outcome, 'not_applicable', id);
    }
  });

  test('a household of four at $3,600 gross is denied on the gross test, and the remedy names the dollar figure — and the household size (finding 3)', async () => {
    const A = await programme();
    await household(A, 'over', ELIGIBLE.map(([f, t, v]) => [f, t, f === 'income.gross_monthly' ? 3600 : v] as F));
    const out = await seal(A.agent, under('over', 'cert.gross_income', 'bind'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    // The deciding clauses: the size-4 branch, and the two exclusions that did not fire.
    const decided = out.reasons.map((r) => `${r.fact} ${r.op} ${r.value}`).sort();
    assert.deepEqual(decided, ['hh.categorically_eligible eq false', 'hh.elderly_or_disabled eq false',
      'hh.size eq 4', 'income.gross_monthly gt 3483']);
    // The remedy is exact, one set per CELL: four cells of income below the
    // size-4 threshold, nine sizes with a higher threshold, and the two
    // exclusions. Four distinct facts, and income is the one a notice should say.
    const facts = [...new Set(out.remedy!.sets.map((s) => s.map((c) => c.fact).join('+')))].sort();
    assert.deepEqual(facts, ['hh.categorically_eligible', 'hh.elderly_or_disabled', 'hh.size', 'income.gross_monthly']);
    assert.ok(out.remedy!.sets.length > 10, `one set per cell: ${out.remedy!.sets.length}`);
    assert.equal(out.remedy!.exhaustive, true);
    const income = out.remedy!.sets.find((s) => s[0]!.fact === 'income.gross_monthly')![0]!;
    assert.deepEqual(income.constraints.filter((k) => k.path.includes('any[3]')), [
      { path: 'all[2].any[3].all[1]', op: 'gt', value: 3483, truth: 'false' }]);
    // FINDING 3 (B4): "become a household of five" is a mathematically valid
    // remedy and not advice. The remedy has no notion of which facts a person
    // can change, and until it does, the notice will print this.
    assert.ok(out.remedy!.sets.some((s) => s[0]!.fact === 'hh.size'), 'the remedy names household size');
  });

  test('a procedural denial waits on the Notice of Missed Interview reaching the household', async () => {
    const A = await programme();
    await household(A, 'nomi', [['interview.completed', 'bool', false], ['notice.interview.delivered_status', 'str', 'returned']], 'usps_ncoa');
    const e = await assert.rejects(async () => seal(A.agent, under('nomi', 'cert.interview_missed', 'bind'), await loadStrengths(A.ws)),
      (err: unknown) => err instanceof ApiError && err.code === 'facts_not_attested');
    void e;
    await household(A, 'nomi', [['notice.interview.delivered_status', 'str', 'delivered']], 'usps_ncoa');
    const out = await seal(A.agent, under('nomi', 'cert.interview_missed', 'bind'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    // FINDING 4: no ex parte rule for SNAP, and the record says so.
    const { rows } = await getPool().query<{ detail: { ex_parte?: { outcome: string } } }>(
      `SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'sealed'`, [out.sealId]);
    assert.equal(rows[0]?.detail.ex_parte?.outcome, 'not_declared');
  });

  test('expedited service: granted on income and liquid resources, and its seven-day clock is met by the grant', async () => {
    const A = await programme();
    await startClock(A.agent, { aliases: person('fast'), scope: 'snap.certification', clock: 'snap_expedited_7_day',
      startedAt: new Date(Date.now() - 2 * 864e5) }, await loadStrengths(A.ws));
    await household(A, 'fast', [['income.gross_monthly', 'int', 100], ['resources.liquid', 'int', 50],
      ['hh.destitute_migrant', 'bool', false], ['expedited.shelter_exceeds_means', 'bool', false]]);
    const out = await seal(A.agent, under('fast', 'cert.expedited', 'permit'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    await advanceClocks(A.ws);
    const [c] = await clocksFor(A.agent, { aliases: person('fast') }, await loadStrengths(A.ws));
    assert.equal(c?.status, 'met');
    assert.equal(c?.sealId, out.sealId);
  });

  test('the work requirement across H.R. 1: a 60-year-old is outside the rule before 1 Nov 2025 and inside it after', async () => {
    const A = await programme();
    await household(A, 'abawd', [['hh.age', 'int', 60], ['abawd.exempt', 'bool', false],
      ['abawd.hours_monthly', 'int', 0], ['abawd.months_used_36', 'int', 3]]);
    const before = await seal(A.agent, under('abawd', 'work.abawd_time_limit', 'bind', { asOf: new Date('2025-10-15') }), await loadStrengths(A.ws));
    assert.equal(before.outcome, 'not_applicable');
    assert.equal(before.ruleRef?.legalAuthority, '7 CFR 273.24 (pre-Pub. L. 119-21)');
    const after = await seal(A.agent, under('abawd', 'work.abawd_time_limit', 'bind',
      { idempotencyKey: 'idem-abawd-after', asOf: new Date('2025-12-01') }), await loadStrengths(A.ws));
    assert.equal(after.outcome, 'sealed');
    assert.equal(after.ruleRef?.legalAuthority, '7 CFR 273.24 as amended by Pub. L. 119-21 §10102');
    assert.ok(after.reasons.some((r) => r.fact === 'hh.age' && r.op === 'lte' && r.value === 64));
  });

  test('the notice for a denial reads as SNAP: the figure, the citation, the hearing right — and the grade', async () => {
    const A = await programme();
    await household(A, 'ntc', ELIGIBLE.map(([f, t, v]) => [f, t, f === 'income.gross_monthly' ? 3600 : v] as F));
    const out = await seal(A.agent, under('ntc', 'cert.gross_income', 'bind'), await loadStrengths(A.ws));
    const n = await noticeFor(A.operator, out.sealId!);
    assert.match(n.text, /Decision: refused/);
    assert.match(n.text, /Legal authority: 7 CFR 273.9\(a\)\(1\)/);
    assert.match(n.text, /Number of people in the SNAP household is 4/);
    assert.match(n.text, /Gross non-exempt monthly income, in dollars is more than 3483/);
    // On the page the cells collapse: one line per fact, the union of its cells.
    assert.match(n.text, /What would change this:\nAny one of the following:/);
    assert.match(n.text, /^\d\. Gross non-exempt monthly income, in dollars is at most 3483$/m);
    assert.match(n.text, /^\d\. Number of people in the SNAP household is not one of 1, 2, 3, 4$/m, 'finding 3, on the page');
    assert.match(n.text, /^\d\. A member is 60 or older, or disabled is true$/m, 'a negated boolean flips, not "is not false"');
    assert.equal((n.text.match(/is at most 3483/g) ?? []).length, 1, 'said once, not once per cell');
    assert.match(n.text, /right to a fair hearing/);
    assert.equal(n.notice.appeal.programme, 'SNAP');
    assert.ok(n.readability.grade > 0);
  });

  test('a rule the grammar cannot express: net income is a derived fact, and the record says nothing about how (finding 1)', async () => {
    const A = await programme();
    await household(A, 'net', ELIGIBLE.map(([f, t, v]) => [f, t, f === 'income.net_monthly' ? 2700 : v] as F));
    const out = await seal(A.agent, under('net', 'cert.net_income', 'bind'), await loadStrengths(A.ws));
    assert.equal(out.outcome, 'sealed');
    // The record commits to the digest of the derived value. The deductions
    // that produced it — where SNAP's payment errors actually live — are not
    // in the rule, so an examiner cannot re-run them from the record.
    const named = new Set(out.reasons.map((r) => r.fact));
    assert.ok(named.has('income.net_monthly'));
    assert.equal(named.has('income.gross_monthly'), false);
  });
});
