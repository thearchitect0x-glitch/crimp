// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, lookup, reevaluate } from '../../src/domain/seal.js';
import { sourceReliability, quadrant, cliffs, quietErrorEstimate, VOLUME_FLOOR } from '../../src/domain/insight.js';
import { actors, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

const who = (tag: string) => [{ type: 'card_fp', value: `c-${tag}` }];

/** Seal a determination about `tag`, optionally from a nominated carrier source. */
async function sealFor(A: Actors, tag: string, opts: {
  delivered?: boolean; refunds?: number; carrierSource?: string;
} = {}) {
  await attest(A.agent, { aliases: who(tag), facts: [
    { fact: 'carrier.delivered', type: 'bool', value: opts.delivered ?? false,
      source: opts.carrierSource ?? 'carrier_api' },
    { fact: 'prior_refunds_90d', type: 'int', value: opts.refunds ?? 1, source: 'core_ledger' },
  ] }, STRENGTHS);
  return seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: who(tag), scope: 'refund',
    disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
}

/** Make a seal lapse by reversing the carrier's scan. */
async function lapse(A: Actors, tag: string, source = 'carrier_api') {
  await attest(A.agent, { aliases: who(tag),
    facts: [{ fact: 'carrier.delivered', type: 'bool', value: true, source }] }, STRENGTHS);
}

async function press(A: Actors, tag: string, sessions: number, per = 4) {
  for (let s = 0; s < sessions; s++) {
    for (let i = 0; i < per; i++) {
      await lookup(A.agent, { aliases: who(tag), scope: 'refund.issue',
        session: `${s}`.repeat(32).slice(0, 32).replace(/[^0-9a-f]/g, 'a') }, STRENGTHS);
    }
  }
}

describe('source reliability', () => {
  test('reports a rate only above the volume floor', async () => {
    const A = await actors();
    const ws = A.ws;
    for (let i = 0; i < 3; i++) await sealFor(A, `sr-small-${i}`);
    const out = await sourceReliability(getPool(), ws);
    const carrier = out.find((r) => r.source === 'carrier_api');
    assert.equal(carrier?.seals, 3);
    assert.equal(carrier?.lapseRate, null, 'three determinations is not a rate');
    assert.match(carrier?.note ?? '', /volume floor/);
  });

  test('a source whose facts keep collapsing shows an elevated lapse rate', async () => {
    const A = await actors();
    const ws = A.ws;
    // `carrier_api` backs every seal. Half of them will have their ground
    // withdrawn; `core_ledger` backs the same seals and shares the blame.
    const n = VOLUME_FLOOR + 4;
    for (let i = 0; i < n; i++) await sealFor(A, `sr-${i}`);
    for (let i = 0; i < n / 2; i++) await lapse(A, `sr-${i}`);
    await reevaluate(ws, 1000);

    const out = await sourceReliability(getPool(), ws);
    const carrier = out.find((r) => r.source === 'carrier_api')!;
    assert.equal(carrier.seals, n);
    assert.ok(carrier.lapseRate !== null, 'above the floor, a rate is reported');
    assert.ok(carrier.lapseRate! > 0.4 && carrier.lapseRate! < 0.6,
      `expected roughly half, got ${carrier.lapseRate}`);
    assert.equal(carrier.admissibility, 'receipt');

    const ledger = out.find((r) => r.source === 'core_ledger')!;
    assert.equal(ledger.lapseRate, carrier.lapseRate,
      'attribution is shared — this says which sources are present when '
      + 'determinations collapse, not which one caused it');
  });

  test('a source nothing has collapsed under reads zero', async () => {
    const A = await actors();
    const ws = A.ws;
    for (let i = 0; i < VOLUME_FLOOR + 1; i++) {
      await sealFor(A, `sr-clean-${i}`, { carrierSource: 'state_registry' });
    }
    const out = await sourceReliability(getPool(), ws);
    assert.equal(out.find((r) => r.source === 'state_registry')?.lapseRate, 0);
  });
});

describe('the wrongful-denial quadrant', () => {
  test('separates all four cells', async () => {
    const A = await actors();
    const ws = A.ws;

    await sealFor(A, 'q-normal');                       // nothing happens
    await sealFor(A, 'q-contested');                    // pressure, premises hold
    await sealFor(A, 'q-quiet');                        // premises fail, silence
    await sealFor(A, 'q-resisted');                     // premises fail AND pressure

    await press(A, 'q-contested', 3);
    await press(A, 'q-resisted', 3);
    await lapse(A, 'q-quiet');
    await lapse(A, 'q-resisted');
    await reevaluate(ws, 1000);

    const q = await quadrant(getPool(), ws);
    assert.equal(q.examined, 4);
    assert.equal(q.normal, 1);
    assert.equal(q.contestedAndCorrect, 1);
    assert.equal(q.quietError, 1,
      'the institution was wrong about somebody who never said a word');
    assert.equal(q.wrongAndResisted, 1,
      'wrong, and they had to fight — the cell nothing else in the world computes');
  });

  test('a clawed seal is not counted as the system being wrong', async () => {
    const A = await actors();
    const ws = A.ws;
    const s = await sealFor(A, 'q-clawed');
    const { claw } = await import('../../src/domain/seal.js');
    await claw(A.operator, { sealId: s.sealId!,
      evidenceSha256: 'b'.repeat(64), evidenceClass: 'receipt' });

    const q = await quadrant(getPool(), ws);
    assert.equal(q.quietError, 0);
    assert.equal(q.wrongAndResisted, 0,
      'a person overruled it — somebody decided, and that decision is on the record');
  });

  test('pressure below the tier threshold is not contestation', async () => {
    const A = await actors();
    const ws = A.ws;
    await sealFor(A, 'q-twice');
    await press(A, 'q-twice', 1, 2);   // asked twice
    const q = await quadrant(getPool(), ws);
    assert.equal(q.normal, 1);
    assert.equal(q.contestedAndCorrect, 0, 'asking twice is not an attack');
  });
});

describe('cliffs', () => {
  test('counts the population either side of a line somebody chose', async () => {
    const A = await actors();
    const ws = A.ws;
    // The rule draws its line at prior_refunds_90d < 3. Place people either side.
    for (const [tag, refunds] of [
      ['cl-a', 2], ['cl-b', 2], ['cl-c', 2],   // just below
      ['cl-d', 3], ['cl-e', 3],                 // just above
      ['cl-f', 0],                              // far below, outside the band
    ] as const) {
      await sealFor(A, tag, { refunds });
    }

    const out = await cliffs(getPool(), ws);
    const line = out.find((c) => c.fact === 'prior_refunds_90d')!;
    assert.equal(line.threshold, 3);
    assert.equal(line.op, 'lt');
    assert.equal(line.justBelow, 3, 'three people at exactly 2');
    assert.equal(line.justAbove, 2, 'two people at exactly 3');

    // Only four seals exist. cl-d and cl-e sit at 3, so the rule did not hold
    // for them and no determination was created.
    assert.equal(line.rulesUsingIt, 4);
  });

  test('the comparison group is invisible in the seal table, which is why this reads attestations', async () => {
    const A = await actors();
    const ws = A.ws;
    await sealFor(A, 'cx-in', { refunds: 2 });    // rule holds  → sealed
    await sealFor(A, 'cx-out', { refunds: 3 });   // rule fails  → no seal at all

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM seals WHERE workspace_id = $1', [ws]);
    assert.equal(Number(rows[0]?.n), 1, 'the person above the line left no determination behind');

    const line = (await cliffs(getPool(), ws)).find((c) => c.fact === 'prior_refunds_90d')!;
    assert.equal(line.justBelow, 1);
    assert.equal(line.justAbove, 1,
      'counting cliffs over seals would be blind to exactly the comparison group '
      + 'the question is about — the people the rule did NOT catch');
  });

  test('a workspace with no ordered comparison draws no cliffs', async () => {
    const A = await actors();
    const ws = A.ws;
    await attest(A.agent, { aliases: who('cl-str'), facts: [
      { fact: 'country', type: 'str', value: 'US', source: 'core_ledger' }] }, STRENGTHS);
    await seal(A.agent, { idempotencyKey: 'idem-cl-str', aliases: who('cl-str'), scope: 'refund',
      disposition: 'bind', rule: { fact: 'country', op: 'in', value: ['US'] }, claw: CLAW }, STRENGTHS);
    assert.deepEqual(await cliffs(getPool(), ws), []);
  });

  test('is scoped to one workspace', async () => {
    const [A, B] = [await actors(), await actors()];
    await sealFor(A, 'cl-iso', { refunds: 2 });
    assert.deepEqual(await cliffs(getPool(), B.ws), []);
  });
});


describe('the error rate among people who never complained', () => {
  test('the quadrant splits by attempts, and the estimate calibrates on the source class of corrections', async () => {
    const A = await actors();
    // Thirty who never came back: six wrong, four corrected by the carrier (a feed), two by the person.
    for (let i = 0; i < 30; i++) await sealFor(A, `z${i}`);
    for (let i = 0; i < 4; i++) await lapse(A, `z${i}`, 'carrier_api');
    for (let i = 4; i < 6; i++) await lapse(A, `z${i}`, 'agent_report');
    // Ten who fought (three refused attempts each): six wrong, two corrected by a feed, four by the person.
    for (let i = 0; i < 10; i++) {
      await sealFor(A, `f${i}`);
      for (let k = 0; k < 3; k++) await lookup(A.agent, { aliases: who(`f${i}`), scope: 'refund', session: 'f'.repeat(32) }, STRENGTHS);
    }
    for (let i = 0; i < 2; i++) await lapse(A, `f${i}`, 'carrier_api');
    for (let i = 2; i < 6; i++) await lapse(A, `f${i}`, 'agent_report');
    await reevaluate(A.ws);

    const q = await quadrant(getPool(), A.ws, 90);
    assert.deepEqual(q.attempts, { zero: { examined: 30, lapsed: 6 }, some: { examined: 10, lapsed: 6 } });

    const e = await quietErrorEstimate(getPool(), A.ws, 90, { minFoughtLapses: 1 });
    assert.deepEqual(e.zeroAttempt, { n: 30, lapsed: 6, lapsedViaFeed: 4, lapsedViaSelf: 2, unattributed: 0 });
    assert.deepEqual(e.fought, { n: 10, lapsed: 6, lapsedViaFeed: 2, lapsedViaSelf: 4, unattributed: 0 });
    assert.equal(e.feedShareAmongFought, 2 / 6);
    assert.equal(e.zeroAttemptLapseRate, 6 / 30);
    // 4 feed-corrected among the quiet, divided by a feed share of one third: twelve wrong of thirty.
    assert.ok(Math.abs(e.calibratedRate! - 12 / 30) < 1e-9, String(e.calibratedRate));
    assert.equal(e.assumptions.length, 3);

    const strict = await quietErrorEstimate(getPool(), A.ws, 90);
    assert.equal(strict.calibratedRate, null, 'below the minimum the share is anecdote, and the estimate says so');
  });
});
