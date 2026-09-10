// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-09 · A rule's rates against its own recent past. Synthetic streams
 * with controlled timestamps, and the seal path's own rows.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { detectDrift, recordDrift, DRIFT } from '../../src/domain/drift.js';
import { listFindings } from '../../src/domain/findings.js';
import { sweepOnce } from '../../src/worker/sweep.js';
import { actors, person, freshWorkspace, STRENGTHS } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };
const DAY = 864e5;

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

/** `perDay` evaluations on each of the last `days` days before the window, `unknownPerDay` of them unknown. */
async function stream(ws: string, rule: string, days: number, perDay: number, unknownPerDay: number, now: Date): Promise<void> {
  const rows: string[] = [];
  const params: unknown[] = [ws, rule];
  for (let d = 1; d <= days; d++) {
    for (let i = 0; i < perDay; i++) {
      const at = new Date(now.getTime() - d * DAY - DRIFT.windowHours * 3600e3 + i * 60e3);
      const unknown = i < unknownPerDay;
      params.push(unknown ? 'unknown' : 'yes', unknown ? 'facts_not_attested' : null, at);
      rows.push(`($1,$2,$${params.length - 2},$${params.length - 1},$${params.length})`);
    }
  }
  await getPool().query(`INSERT INTO evaluation_log (workspace_id, rule_key, outcome, reason, occurred_at) VALUES ${rows.join(',')}`, params);
}
async function today(ws: string, rule: string, n: number, unknown: number, now: Date): Promise<void> {
  const rows: string[] = []; const params: unknown[] = [ws, rule];
  for (let i = 0; i < n; i++) {
    const at = new Date(now.getTime() - (n - i) * 60e3);
    params.push(i < unknown ? 'unknown' : 'yes', i < unknown ? 'facts_not_attested' : null, at);
    rows.push(`($1,$2,$${params.length - 2},$${params.length - 1},$${params.length})`);
  }
  await getPool().query(`INSERT INTO evaluation_log (workspace_id, rule_key, outcome, reason, occurred_at) VALUES ${rows.join(',')}`, params);
}

describe('drift', () => {
  test('a feed outage — unknown spikes from 3% to 83% — is detected within one window, on the outcome and on the reason', async () => {
    const ws = await freshWorkspace();
    const now = new Date();
    await stream(ws, 'medicaid/renewal.income', 14, 30, 1, now);   // 3.3% unknown, steady
    await today(ws, 'medicaid/renewal.income', 30, 25, now);        // 83% unknown
    const found = await detectDrift(ws, now);
    assert.deepEqual(found.map((f) => f.metric).sort(), ['outcome:unknown', 'reason:facts_not_attested']);
    const u = found.find((f) => f.metric === 'outcome:unknown')!;
    assert.equal(u.baseline.days, 14);
    assert.equal(u.baseline.mean, 0.033);
    assert.equal(u.baseline.sd, 0, 'a perfectly steady baseline');
    assert.equal(u.current.evaluations, 30);
    assert.equal(u.current.rate, 0.833);
    // The lower of mean+3σ (= mean, with σ = 0) and 2×mean. A steady
    // baseline makes the test strict; minDelta is what keeps it sane.
    assert.equal(u.threshold, 0.033);
  });

  test('a day like every other day is not drift', async () => {
    const ws = await freshWorkspace();
    const now = new Date();
    await stream(ws, 'r', 14, 30, 3, now);
    await today(ws, 'r', 30, 3, now);
    assert.deepEqual(await detectDrift(ws, now), []);
  });

  test('a small move, or a small window, or a short baseline, is not drift either', async () => {
    const ws = await freshWorkspace();
    const now = new Date();
    await stream(ws, 'small', 14, 100, 3, now);
    await today(ws, 'small', 100, 7, now);              // 3% → 7%: over 2× but under minDelta
    assert.deepEqual(await detectDrift(ws, now), []);
    await stream(ws, 'thin', 14, 30, 1, now);
    await today(ws, 'thin', 10, 9, now);                // 90%, but only ten evaluations
    assert.deepEqual(await detectDrift(ws, now), []);
    await stream(ws, 'young', 2, 30, 1, now);
    await today(ws, 'young', 30, 25, now);              // two days of history is not a baseline
    assert.deepEqual(await detectDrift(ws, now), []);
  });

  test('is a finding, recorded once per rule, metric and window, and reachable from the sweep', async () => {
    const ws = await freshWorkspace();
    const now = new Date();
    await stream(ws, 'snap/cert.income', 14, 40, 2, now);
    await today(ws, 'snap/cert.income', 40, 30, now);
    const first = await recordDrift(ws, now);
    assert.equal(first.length, 2);
    assert.equal(first[0]?.subjectKind, 'rule');
    assert.equal(first[0]?.subjectId, 'snap/cert.income');
    assert.deepEqual(await recordDrift(ws, now), [], 'not reported twice in one window');
    // The sweep is global; for THIS workspace it must add nothing.
    await sweepOnce({ forceDrift: true });
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM findings WHERE workspace_id = $1 AND class = 'drift'`, [ws]);
    assert.equal(Number(rows[0]?.n), 2, 'the sweep found the same findings already recorded');
  });

  test('the seal path writes the log: yes, no, and unknown with its reason — and nothing about the person', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('d1'), facts: [
      { fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' } ] }, STRENGTHS);
    await attest(A.agent, { aliases: person('d2'), facts: [
      { fact: 'household.income', type: 'int', value: 100, source: 'state_registry' } ] }, STRENGTHS);
    const mk = (tag: string) => ({ idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'medicaid.renewal',
      disposition: 'bind' as const, rule: RULE, claw: CLAW });
    await seal(A.agent, mk('d1'), STRENGTHS);                                    // yes
    await seal(A.agent, mk('d2'), STRENGTHS);                                    // no
    await seal(A.agent, mk('d3'), STRENGTHS).catch(() => undefined);             // unknown
    await seal(A.agent, mk('d1'), STRENGTHS);                                    // replay: not an evaluation
    const { rows } = await getPool().query<{ outcome: string; reason: string | null; rule_key: string }>(
      'SELECT outcome, reason, rule_key FROM evaluation_log WHERE workspace_id = $1 ORDER BY id', [A.ws]);
    assert.deepEqual(rows.map((r) => [r.outcome, r.reason]), [['yes', null], ['no', null], ['unknown', 'facts_not_attested']]);
    assert.match(rows[0]!.rule_key, /^[0-9a-f]{16}$/);
    const { rows: cols } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'evaluation_log'`);
    assert.equal(cols.some((c) => c.column_name.includes('subject')), false, 'no subject column exists to fill');
    assert.equal((await listFindings(A.operator, { class: 'drift' })).length, 0);
  });
});

describe('the evaluation log', () => {
  test('is pruned by the sweep past the baseline it feeds', async () => {
    const ws = await freshWorkspace();
    await getPool().query(
      `INSERT INTO evaluation_log (workspace_id, rule_key, outcome, reason, occurred_at) VALUES
         ($1,'old','yes',null, now() - interval '40 days'), ($1,'recent','yes',null, now() - interval '2 days')`, [ws]);
    await sweepOnce();
    const { rows } = await getPool().query<{ rule_key: string }>(
      'SELECT rule_key FROM evaluation_log WHERE workspace_id = $1', [ws]);
    assert.deepEqual(rows.map((r) => r.rule_key), ['recent']);
  });
});
