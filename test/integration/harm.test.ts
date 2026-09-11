// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-05 · The reversal carries its cost, and only a reversal does.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, reevaluate, claw } from '../../src/domain/seal.js';
import { declareRuleset, commitRule } from '../../src/domain/registry.js';
import { harmLedger } from '../../src/domain/harm.js';
import { actors, person, ageSeal, expireSeal, stateOf, hash64, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };
const DAY = 86400;

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function income(A: Actors, tag: string, value: number): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'household.income', type: 'int', value, source: 'state_registry' } ] }, STRENGTHS);
}
async function sealed(A: Actors, tag: string, disposition: 'bind' | 'permit' | 'commit', scope = 'snap.certification',
  extra: Record<string, unknown> = {}): Promise<string> {
  const out = await seal(A.agent, { idempotencyKey: `idem-${tag}-${disposition}`, aliases: person(tag), scope,
    disposition, rule: RULE, claw: CLAW, ...extra }, STRENGTHS);
  assert.equal(out.outcome, 'sealed');
  return out.sealId!;
}
async function harmOn(sealId: string, kind: string): Promise<Record<string, unknown> | null> {
  const { rows } = await getPool().query<{ detail: { harm?: Record<string, unknown> } }>(
    'SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = $2', [sealId, kind]);
  return rows[0]?.detail.harm ?? null;
}

describe('harm is attached to a reversal', () => {
  test('a SNAP refusal that stood 400 days and lapsed: 400 without coverage, 365 owed', async () => {
    const A = await actors();
    await income(A, 'h1', 3000);
    const id = await sealed(A, 'h1', 'bind');
    await ageSeal(id, 400 * DAY);
    await income(A, 'h1', 1000);
    await reevaluate(A.ws);
    assert.equal(await stateOf(id), 'lapsed');
    const h = await harmOn(id, 'lapsed');
    assert.ok(h, 'the lapsed event carries harm');
    assert.equal(h['programme'], 'snap');
    assert.equal(h['days_without_coverage'], 400);
    assert.equal(h['days_owed'], 365);
    assert.equal(h['window_days'], 365);
    assert.equal(h['authority'], '7 CFR 273.17(a)');
  });

  test('a Medicaid refusal: no window, every day owed', async () => {
    const A = await actors();
    await income(A, 'h2', 3000);
    const id = await sealed(A, 'h2', 'bind', 'medicaid.renewal');
    await ageSeal(id, 400 * DAY);
    await income(A, 'h2', 1000);
    await reevaluate(A.ws);
    const h = await harmOn(id, 'lapsed');
    assert.equal(h?.['days_without_coverage'], 400);
    assert.equal(h?.['days_owed'], 400);
    assert.equal(h?.['window_days'], null);
  });
});

describe('harm is never computed for a non-void record', () => {
  test('an expiry', async () => {
    const A = await actors();
    await income(A, 'e1', 3000);
    const id = await sealed(A, 'e1', 'bind', 'snap.certification', { expiresAt: new Date(Date.now() + 864e5) });
    await ageSeal(id, 400 * DAY);
    await expireSeal(id);
    await reevaluate(A.ws);
    assert.equal(await stateOf(id), 'expired');
    assert.equal(await harmOn(id, 'expired'), null);
  });
  test('a taint', async () => {
    const A = await actors();
    await income(A, 'e2', 3000);
    const id = await sealed(A, 'e2', 'bind');
    await ageSeal(id, 400 * DAY);
    await getPool().query(`DELETE FROM attestations WHERE workspace_id = $1 AND fact = 'household.income'`, [A.ws]);
    await getPool().query('UPDATE seals SET evaluation_due = true WHERE id = $1', [id]);
    await reevaluate(A.ws);
    assert.equal(await stateOf(id), 'tainted');
    assert.equal(await harmOn(id, 'tainted'), null);
  });
  test('a claw — a person overruled it and owns that judgement', async () => {
    const A = await actors();
    await income(A, 'e3', 3000);
    const id = await sealed(A, 'e3', 'bind');
    await ageSeal(id, 400 * DAY);
    await claw(A.operator, { sealId: id, evidenceSha256: hash64('ledger-correction-2026-09'), evidenceClass: 'internal' });
    assert.equal(await stateOf(id), 'clawed');
    assert.equal(await harmOn(id, 'clawed'), null);
  });
  test('a permit that lapsed, and a commit that lapsed', async () => {
    const A = await actors();
    await income(A, 'e4', 3000);
    const permit = await sealed(A, 'e4', 'permit');
    const commit = await sealed(A, 'e4', 'commit');
    await ageSeal(permit, 400 * DAY);
    await ageSeal(commit, 400 * DAY);
    await income(A, 'e4', 1000);
    await reevaluate(A.ws);
    assert.equal(await stateOf(permit), 'lapsed');
    assert.equal(await stateOf(commit), 'lapsed');
    assert.equal(await harmOn(permit, 'lapsed'), null);
    assert.equal(await harmOn(commit, 'lapsed'), null);
  });
});

describe('the harm ledger', () => {
  test('totals by programme, rule and month, from the events alone', async () => {
    const A = await actors();
    await declareRuleset(A.operator, { ruleset: 'snap' });
    await commitRule(A.operator, { ruleset: 'snap', ruleId: 'cert.income', rule: RULE,
      legalAuthority: '7 CFR 273.9', effectiveFrom: new Date('2026-01-01') });
    for (const [tag, days, scope, ref] of [
      ['l1', 100, 'snap.certification', true], ['l2', 500, 'snap.certification', true],
      ['l3', 30, 'medicaid.renewal', false],
    ] as const) {
      await income(A, tag, 3000);
      const id = await sealed(A, tag, 'bind', scope, ref ? { rule: undefined, ruleRef: { ruleset: 'snap', ruleId: 'cert.income' } } : {});
      await ageSeal(id, days * DAY);
      await income(A, tag, 1000);
    }
    await reevaluate(A.ws);
    const rows = await harmLedger(A.operator);
    const month = new Date().toISOString().slice(0, 7);
    const snap = rows.find((r) => r.programme === 'snap');
    const medicaid = rows.find((r) => r.programme === 'medicaid');
    assert.deepEqual(snap, { programme: 'snap', rule: 'cert.income', month, reversals: 2,
      daysWithoutCoverage: 600, daysOwed: 100 + 365 });
    assert.equal(medicaid?.reversals, 1);
    assert.equal(medicaid?.daysOwed, 30);
    assert.match(medicaid?.rule ?? '', /^[0-9a-f]{16}$/, 'an inline rule is named by its hash');
  });
});
