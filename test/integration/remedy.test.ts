// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-02 · The remedy travels with the determination: stored, replayed, exported. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { proof } from '../../src/domain/record.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function facts(A: Actors, tag: string, delivered: boolean, refunds: number): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'carrier.delivered', type: 'bool', value: delivered, source: 'carrier_api' },
    { fact: 'prior_refunds_90d', type: 'int', value: refunds, source: 'core_ledger' },
  ] }, STRENGTHS);
}
const input = (tag: string, disposition: 'bind' | 'permit' | 'commit') => ({
  idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'refund', disposition, rule: RULE, claw: CLAW,
});

describe('a sealed refusal carries what would make it lapse', () => {
  test('two single-fact remedies, value-free, stored and exported', async () => {
    const A = await actors();
    await facts(A, 'r1', false, 1);
    const out = await seal(A.agent, input('r1', 'bind'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    assert.equal(out.remedy?.target, 'false');
    assert.deepEqual(out.remedy?.sets.map((s) => s.map((c) => c.fact)), [['carrier.delivered'], ['prior_refunds_90d']]);
    assert.equal(JSON.stringify(out.remedy).includes('"observed"'), false, 'nothing observed is in it');

    const rec = await proof(A.operator, out.sealId!);
    assert.deepEqual(rec.remedy, out.remedy, 'the record carries exactly what was returned');
    const replay = await seal(A.agent, input('r1', 'bind'), STRENGTHS);
    assert.equal(replay.outcome, 'replayed');
    assert.deepEqual(replay.remedy, out.remedy, 'a replay returns the stored remedy, not a fresh one');
  });

  test('a refusal that did not apply has nothing to remedy; a permit that did not apply says what would earn it', async () => {
    const A = await actors();
    await facts(A, 'n1', true, 5);
    const bind = await seal(A.agent, input('n1', 'bind'), STRENGTHS);
    assert.equal(bind.outcome, 'not_applicable');
    assert.equal(bind.remedy, null);
    const permit = await seal(A.agent, { ...input('n1', 'permit'), idempotencyKey: 'idem-n1-permit' }, STRENGTHS);
    assert.equal(permit.outcome, 'not_applicable');
    assert.equal(permit.remedy?.target, 'true');
    assert.deepEqual(permit.remedy?.sets.map((s) => s.map((c) => c.fact)), [['carrier.delivered', 'prior_refunds_90d']]);
  });

  test('a commit has no side to be on', async () => {
    const A = await actors();
    await facts(A, 'c1', false, 1);
    const out = await seal(A.agent, input('c1', 'commit'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    assert.equal(out.remedy, null);
    assert.equal((await proof(A.operator, out.sealId!)).remedy, null);
  });

  test('an undecided refusal says which facts, and in which cells, would settle it the person\'s way', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('u1'), facts: [
      { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' },
    ] }, STRENGTHS);
    await assert.rejects(() => seal(A.agent, input('u1', 'bind'), STRENGTHS), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, 'facts_not_attested');
      const d = e.detail as { missing: string[]; remedy: { target: string; sets: Array<Array<{ fact: string }>> } };
      assert.deepEqual(d.missing, ['prior_refunds_90d']);
      assert.equal(d.remedy.target, 'false');
      // Either fact alone can make a refusal not apply: flip delivery, or
      // attest refunds in the cell where the clause fails.
      assert.deepEqual(d.remedy.sets.map((s) => s.map((c) => c.fact)), [['carrier.delivered'], ['prior_refunds_90d']]);
      return true;
    });
  });
});
