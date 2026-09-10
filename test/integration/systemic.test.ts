// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-06 · One overturn reaches every determination made under the same
 * rule — by registered id or identical content, narrowed by fact pattern —
 * and touches nothing else. Outcomes do not change; visibility does.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest, type AttestInput } from '../../src/domain/attest.js';
import { seal, lookup } from '../../src/domain/seal.js';
import { declareRuleset, commitRule } from '../../src/domain/registry.js';
import { propagateAdjudications, workspacesWithPendingReversals, ADJUDICATION } from '../../src/domain/systemic.js';
import { listFindings } from '../../src/domain/findings.js';
import { proof } from '../../src/domain/record.js';
import { noticeFor } from '../../src/domain/notice.js';
import { sweepOnce } from '../../src/worker/sweep.js';
import { actors, person, countEvents, stateOf, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const INCOME = { fact: 'household.income', op: 'gt', value: 2000 };
const EITHER = { any: [INCOME, { fact: 'household.assets', op: 'gt', value: 5000 }] };
const OTHER = { fact: 'household.size', op: 'lt', value: 1 };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function facts(A: Actors, tag: string, f: Record<string, number>): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: Object.entries(f).map(([fact, value]) =>
    ({ fact, type: 'int' as const, value, source: 'state_registry' })) }, STRENGTHS);
}
async function bind(A: Actors, tag: string, how: { ruleRef?: { ruleset: string; ruleId: string }; rule?: unknown }): Promise<string> {
  const out = await seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'medicaid.renewal',
    disposition: 'bind', claw: CLAW, ...how }, STRENGTHS);
  assert.equal(out.outcome, 'sealed', tag);
  return out.sealId!;
}
async function ruling(A: Actors, tag: string, extra: Record<string, string> = {}, by: 'agent' | 'operator' = 'operator', source = 'state_registry'): Promise<void> {
  await attest(A[by], { aliases: person(tag), facts: [
    { fact: ADJUDICATION.ruling, type: 'str', value: 'reversed', source: 'state_registry' },
    { fact: ADJUDICATION.ruleset, type: 'str', value: 'medicaid', source: 'state_registry' },
    { fact: ADJUDICATION.ruleId, type: 'str', value: 'renewal.means', source: 'state_registry' },
    { fact: ADJUDICATION.authority, type: 'str', value: 'fair_hearing', source: 'state_registry' },
    { fact: ADJUDICATION.date, type: 'time', value: Date.UTC(2026, 8, 1), source: 'state_registry' },
    ...Object.entries(extra).map(([fact, value]) => ({ fact, type: 'str' as const, value, source: 'state_registry' })),
  ].map((f) => ({ ...f, source })) as AttestInput[] }, STRENGTHS);
}

/** Three under the rule by id, one by identical inline content, one under another rule. */
async function population(A: Actors): Promise<Record<string, string>> {
  await declareRuleset(A.operator, { ruleset: 'medicaid' });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.means', rule: EITHER,
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.size', rule: OTHER,
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
  const ids: Record<string, string> = {};
  await facts(A, 'p1', { 'household.income': 3000, 'household.assets': 100 });
  await facts(A, 'p2', { 'household.income': 3000, 'household.assets': 100 });
  await facts(A, 'p3', { 'household.income': 100, 'household.assets': 9000 });   // refused on assets alone
  await facts(A, 'p4', { 'household.income': 3000, 'household.assets': 100 });
  await facts(A, 'p5', { 'household.size': 0 });
  const byId = { ruleset: 'medicaid', ruleId: 'renewal.means' };
  ids['p1'] = await bind(A, 'p1', { ruleRef: byId });
  ids['p2'] = await bind(A, 'p2', { ruleRef: byId });
  ids['p3'] = await bind(A, 'p3', { ruleRef: byId });
  ids['p4'] = await bind(A, 'p4', { rule: EITHER });                     // inline, same content
  ids['p5'] = await bind(A, 'p5', { ruleRef: { ruleset: 'medicaid', ruleId: 'renewal.size' } });
  return ids;
}

describe('one overturn', () => {
  test('reaches every determination under the same rule — by id and by content — and no other', async () => {
    const A = await actors();
    const ids = await population(A);
    await ruling(A, 'p1');
    assert.deepEqual(await workspacesWithPendingReversals(getPool()), [A.ws]);

    const out = await propagateAdjudications(A.ws);
    assert.equal(out.reviews.length, 1);
    assert.equal(out.flagged, 4);
    assert.deepEqual(new Set(out.reviews[0]!.affected), new Set([ids['p1'], ids['p2'], ids['p3'], ids['p4']]));

    for (const k of ['p1', 'p2', 'p3', 'p4']) {
      assert.equal(await countEvents(ids[k]!, 'systemic_review'), 1, k);
      assert.equal(await stateOf(ids[k]!), 'sealed', `${k}: the outcome did not change`);
    }
    assert.equal(await countEvents(ids['p5']!, 'systemic_review'), 0, 'a different rule is untouched');
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM seals WHERE workspace_id = $1 AND evaluation_due AND review_flagged_at IS NOT NULL`, [A.ws]);
    assert.equal(Number(rows[0]?.n), 4, 'affected determinations are due and flagged');

    const findings = await listFindings(A.operator, { class: 'systemic_review' });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.subjectId, 'medicaid/renewal.means');
    assert.equal(findings[0]?.detail['count'], 4);
    assert.equal((findings[0]?.detail['affected'] as string[]).length, 4);
    assert.equal((findings[0]?.detail['adjudication'] as { authority: string }).authority, 'fair_hearing');

    // A second pass propagates nothing: the ruling has been dealt with.
    assert.deepEqual(await propagateAdjudications(A.ws), { reviews: [], flagged: 0 });
    assert.deepEqual(await workspacesWithPendingReversals(getPool()), []);
    assert.equal((await listFindings(A.operator, { class: 'systemic_review' })).length, 1);
  });

  test('a fact pattern narrows it to determinations whose reasons rest on that fact', async () => {
    const A = await actors();
    const ids = await population(A);
    await ruling(A, 'p1', { [ADJUDICATION.pattern]: 'household.income' });
    const out = await propagateAdjudications(A.ws);
    // p3 was refused on assets alone; its reasons never name income.
    assert.deepEqual(new Set(out.reviews[0]!.affected), new Set([ids['p1'], ids['p2'], ids['p4']]));
    assert.equal(await countEvents(ids['p3']!, 'systemic_review'), 0);
  });

  test('propagates only from a person through an authority source: an agent\'s ruling, or an internal one, reaches nothing', async () => {
    const A = await actors();
    const ids = await population(A);
    await ruling(A, 'p1', {}, 'agent');                       // an agent key, even via the authority source
    assert.deepEqual(await propagateAdjudications(A.ws), { reviews: [], flagged: 0 });
    assert.deepEqual(await workspacesWithPendingReversals(getPool()), []);
    await ruling(A, 'p2', {}, 'operator', 'core_ledger');      // a person, but an internal source
    assert.deepEqual(await propagateAdjudications(A.ws), { reviews: [], flagged: 0 });
    assert.equal(await countEvents(ids['p3']!, 'systemic_review'), 0);
    assert.equal((await listFindings(A.operator, { class: 'systemic_review' })).length, 0);
    await ruling(A, 'p3');                                     // a person, through the hearing authority
    assert.equal((await propagateAdjudications(A.ws)).flagged, 4);
  });

  test('a reversal that names no rule is about one person, and is recorded as dealt with', async () => {
    const A = await actors();
    const ids = await population(A);
    await attest(A.operator, { aliases: person('p1'), facts: [
      { fact: ADJUDICATION.ruling, type: 'str', value: 'reversed', source: 'state_registry' } ] }, STRENGTHS);
    const out = await propagateAdjudications(A.ws);
    assert.deepEqual(out, { reviews: [], flagged: 0 });
    assert.equal(await countEvents(ids['p2']!, 'systemic_review'), 0);
    assert.deepEqual(await workspacesWithPendingReversals(getPool()), []);
  });

  test('is visible on the lookup, the proof and the notice, and runs from the sweep', async () => {
    const A = await actors();
    const ids = await population(A);
    await ruling(A, 'p1');
    const pass = await sweepOnce();
    assert.ok(pass.systemic.flagged >= 4);

    const seen = await lookup(A.agent, { aliases: person('p2'), scope: 'medicaid.renewal' }, STRENGTHS);
    assert.equal(seen.determinations[0]?.underReview, true);
    const other = await lookup(A.agent, { aliases: person('p5'), scope: 'medicaid.renewal' }, STRENGTHS);
    assert.equal(other.determinations[0]?.underReview, false);

    const rec = await proof(A.operator, ids['p2']!);
    assert.ok(rec.reviewFlaggedAt instanceof Date);
    assert.equal(rec.events.some((e) => e.kind === 'systemic_review'), true);

    const n = await noticeFor(A.operator, ids['p2']!);
    assert.match(n.text, /under review following a ruling on the rule it applied/);
    assert.equal(n.notice.outcome.underReview, true);
    const quiet = await noticeFor(A.operator, ids['p5']!);
    assert.equal(quiet.text.includes('under review'), false);
  });
});
