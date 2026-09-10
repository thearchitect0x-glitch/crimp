// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-03 · A clock starts from an attested event, is met by the record, is
 * missed by the calendar, and a missed clock is a finding against the agency
 * — never a change to the person's determination.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest, eraseSubject } from '../../src/domain/attest.js';
import { seal, reevaluate } from '../../src/domain/seal.js';
import { startClock, advanceClocks, resolveMissed, clocksFor, timeliness } from '../../src/domain/clocks.js';
import { CLOCKS } from '../../src/domain/clocks.config.js';
import { listFindings } from '../../src/domain/findings.js';
import { sweepOnce } from '../../src/worker/sweep.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, stateOf, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuse(A: Actors, tag: string, scope = 'medicaid.application'): Promise<string> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' } ] }, STRENGTHS);
  const out = await seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: person(tag), scope,
    disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
  assert.equal(out.outcome, 'sealed');
  return out.sealId!;
}

describe('a clock', () => {
  test('is created on record open, from an attested start, with its due date derived from config', async () => {
    const A = await actors();
    const start = daysAgo(1);
    const c = await startClock(A.agent, { aliases: person('c1'), scope: 'medicaid.application',
      clock: 'application_45_day', startedAt: start }, STRENGTHS);
    assert.equal(c.outcome, 'started');
    assert.equal(c.status, 'running');
    assert.equal(c.dueAt.getTime() - c.startedAt.getTime(), CLOCKS['application_45_day']!.hours * 3600e3);
    assert.equal(c.authority, '42 CFR 435.912(c)(3)(ii)');
    // Starting it again is a replay while it runs.
    const again = await startClock(A.agent, { aliases: person('c1'), scope: 'medicaid.application',
      clock: 'application_45_day', startedAt: start }, STRENGTHS);
    assert.equal(again.outcome, 'already_running');
    assert.equal(again.id, c.id);
    // It is readable by aliases, never by id.
    const mine = await clocksFor(A.agent, { aliases: person('c1') }, STRENGTHS);
    assert.deepEqual(mine.map((x) => x.id), [c.id]);
  });

  test('refuses a name it does not know, and a start in the future', async () => {
    const A = await actors();
    await assert.rejects(() => startClock(A.agent, { aliases: person('x'), scope: 'medicaid',
      clock: 'fortnight', startedAt: daysAgo(1) }, STRENGTHS),
    (e: unknown) => e instanceof ApiError && e.code === 'unknown_clock');
    await assert.rejects(() => startClock(A.agent, { aliases: person('x'), scope: 'medicaid',
      clock: 'snap_30_day', startedAt: new Date(Date.now() + 864e5) }, STRENGTHS),
    (e: unknown) => e instanceof ApiError && e.code === 'invalid_request');
  });

  test('is met by a determination sealed in scope, on time, and closes without a finding', async () => {
    const A = await actors();
    const c = await startClock(A.agent, { aliases: person('m1'), scope: 'medicaid.application',
      clock: 'application_45_day', startedAt: daysAgo(10) }, STRENGTHS);
    const sealId = await refuse(A, 'm1');
    const a = await advanceClocks(A.ws);
    assert.deepEqual(a, { met: 1, missed: 0, examined: 1 });
    const [after] = await clocksFor(A.agent, { aliases: person('m1') }, STRENGTHS);
    assert.equal(after?.status, 'met');
    assert.equal(after?.sealId, sealId);
    assert.ok(after?.metAt);
    assert.equal((await listFindings(A.operator, {})).length, 0);
    assert.equal(c.id, after?.id);
  });

  test('a determination at a broader scope meets it; one in an unrelated scope does not', async () => {
    const A = await actors();
    await startClock(A.agent, { aliases: person('s1'), scope: 'medicaid.application',
      clock: 'application_45_day', startedAt: daysAgo(10) }, STRENGTHS);
    await refuse(A, 's1', 'snap');
    await advanceClocks(A.ws);
    assert.equal((await clocksFor(A.agent, { aliases: person('s1') }, STRENGTHS))[0]?.status, 'running',
      'a SNAP determination does not decide a Medicaid application');
    await attest(A.agent, { aliases: person('s1'), facts: [
      { fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' } ] }, STRENGTHS);
    await seal(A.agent, { idempotencyKey: 'idem-s1-broad', aliases: person('s1'), scope: 'medicaid',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    await advanceClocks(A.ws);
    assert.equal((await clocksFor(A.agent, { aliases: person('s1') }, STRENGTHS))[0]?.status, 'met');
  });

  test('is missed when due passes first, and the miss is a finding against the agency — once', async () => {
    const A = await actors();
    const c = await startClock(A.agent, { aliases: person('x1'), scope: 'snap.application',
      clock: 'snap_30_day', startedAt: daysAgo(31) }, STRENGTHS);
    const a = await advanceClocks(A.ws);
    assert.deepEqual(a, { met: 0, missed: 1, examined: 1 });
    const findings = await listFindings(A.operator, { class: 'agency_timeliness' });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.subjectKind, 'clock');
    assert.equal(findings[0]?.subjectId, c.id);
    assert.equal(findings[0]?.detail['clock'], 'snap_30_day');
    assert.equal(findings[0]?.detail['authority'], '7 CFR 273.2(g)(1)');
    assert.equal(findings[0]?.detail['resolved_at'], null);
    assert.equal(JSON.stringify(findings[0]).includes('subject_id":"sub_'), false, 'a finding names no person');
    // A second sweep changes nothing and emits nothing.
    assert.deepEqual(await advanceClocks(A.ws), { met: 0, missed: 0, examined: 0 });
    assert.equal((await listFindings(A.operator, {})).length, 1);
  });

  test('a late determination resolves a missed clock and records how late', async () => {
    const A = await actors();
    await startClock(A.agent, { aliases: person('l1'), scope: 'snap.application',
      clock: 'snap_expedited_7_day', startedAt: daysAgo(9) }, STRENGTHS);
    await advanceClocks(A.ws);
    assert.equal((await clocksFor(A.agent, { aliases: person('l1') }, STRENGTHS))[0]?.status, 'missed');
    const sealId = await refuse(A, 'l1', 'snap.application');
    await resolveMissed(A.ws);
    const [c] = await clocksFor(A.agent, { aliases: person('l1') }, STRENGTHS);
    assert.equal(c?.status, 'missed', 'late is still missed');
    assert.equal(c?.sealId, sealId);
    assert.ok(c?.resolvedAt);
    const t = await timeliness(A.operator);
    assert.equal(t[0]?.clock, 'snap_expedited_7_day');
    assert.equal(t[0]?.missed, 1);
    assert.ok((t[0]?.meanHoursLate ?? 0) >= 47 && (t[0]?.meanHoursLate ?? 0) <= 49, `late ${t[0]?.meanHoursLate}h`);
  });

  test('is met by an attested fact when the definition says so', async () => {
    const A = await actors();
    await startClock(A.agent, { aliases: person('h1'), scope: 'medicaid.hearing',
      clock: 'fair_hearing_90_day', startedAt: daysAgo(20) }, STRENGTHS);
    await attest(A.agent, { aliases: person('h1'), facts: [
      { fact: 'adjudication.ruling', type: 'str', value: 'reversed', source: 'state_registry' } ] }, STRENGTHS);
    await advanceClocks(A.ws);
    assert.equal((await clocksFor(A.agent, { aliases: person('h1') }, STRENGTHS))[0]?.status, 'met');
  });
});

describe('a finding', () => {
  test('never changes the determination, and a clock survives re-evaluation', async () => {
    const A = await actors();
    const sealId = await refuse(A, 'f1');
    await startClock(A.agent, { aliases: person('f1'), scope: 'snap.application',
      clock: 'snap_30_day', startedAt: daysAgo(40) }, STRENGTHS);
    const pass = await sweepOnce();
    assert.ok(pass.clocks.missed >= 1);
    assert.equal(await stateOf(sealId), 'sealed', 'the agency being late does not refuse anybody');

    // Now the person's facts change and the refusal lapses; the clock is
    // untouched by the re-evaluation, and the finding stands.
    await attest(A.agent, { aliases: person('f1'), facts: [
      { fact: 'household.income', type: 'int', value: 1000, source: 'state_registry' } ] }, STRENGTHS);
    await reevaluate(A.ws);
    assert.equal(await stateOf(sealId), 'lapsed');
    const clocks = await clocksFor(A.agent, { aliases: person('f1') }, STRENGTHS);
    assert.equal(clocks.length, 1);
    assert.equal(clocks[0]?.status, 'missed');
    assert.equal((await listFindings(A.operator, { class: 'agency_timeliness' })).length, 1);
  });

  test('outlives the erasure of the person it was about — it names none', async () => {
    const A = await actors();
    const c = await startClock(A.agent, { aliases: person('e1'), scope: 'snap.application',
      clock: 'snap_30_day', startedAt: daysAgo(40) }, STRENGTHS);
    await advanceClocks(A.ws);
    const { rows } = await getPool().query<{ subject_id: string }>(
      'SELECT subject_id FROM clocks WHERE id = $1', [c.id]);
    await eraseSubject(A.ws, rows[0]!.subject_id);
    const { rows: gone } = await getPool().query('SELECT 1 FROM clocks WHERE id = $1', [c.id]);
    assert.equal(gone.length, 0, 'the clock was personal data');
    assert.equal((await listFindings(A.operator, {})).length, 1, 'the finding was not');
  });
});

describe('reading clocks', () => {
  test('attaches nothing: a new alias presented beside a known one is not bound by a read', async () => {
    const A = await actors();
    await startClock(A.agent, { aliases: person('ro1'), scope: 'snap.application', clock: 'snap_30_day',
      startedAt: daysAgo(1) }, STRENGTHS);
    const before = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM subject_aliases WHERE workspace_id = $1', [A.ws]);
    const found = await clocksFor(A.agent, { aliases: [...person('ro1'), { type: 'device', value: 'shared-kiosk' }] }, STRENGTHS);
    assert.equal(found.length, 1, 'the known alias resolves the subject');
    const after = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM subject_aliases WHERE workspace_id = $1', [A.ws]);
    assert.equal(after.rows[0]?.n, before.rows[0]?.n, 'the shared device was not bound to anybody');
    await assert.rejects(() => clocksFor(A.agent, { aliases: [{ type: 'device', value: 'nobody' }] }, STRENGTHS),
      (e: unknown) => e instanceof ApiError && e.code === 'unknown_subject');
  });
});
