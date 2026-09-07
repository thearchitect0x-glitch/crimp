// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The correction channel, and whether it actually reaches everybody.
 *
 * The first test here is a regression for a defect that made every other test
 * in this file pass against a broken system: `reevaluate` selected
 * `ORDER BY sealed_at LIMIT 100`, and a determination that does not change
 * state stays at the front of that ordering forever. So the sweep re-examined
 * the same oldest hundred on every pass and never reached the hundred-and-
 * first. Every existing test used far fewer than a hundred determinations, so
 * every existing test passed.
 *
 * A sweep that never runs is visibly missing. This one ran, returned quickly,
 * reported changes, and silently stopped correcting after the hundredth person.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, reevaluate, sweepLag } from '../../src/domain/seal.js';
import { sweepOnce } from '../../src/worker/sweep.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, stateOf, expireSeal, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'carrier.delivered', op: 'eq', value: false };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function say(A: Actors, tag: string, delivered: boolean, expiresAt?: Date): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'carrier.delivered', type: 'bool', value: delivered, source: 'carrier_api',
      ...(expiresAt ? { expiresAt } : {}) },
  ] }, STRENGTHS);
}

async function bind(A: Actors, tag: string): Promise<string> {
  const s = await seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: person(tag),
    scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
  assert.equal(s.outcome, 'sealed', `expected ${tag} to seal`);
  return s.sealId!;
}

/* ── The regression ──────────────────────────────────────────────────── */

describe('the sweep reaches past the batch size', () => {
  test('a determination beyond the first batch still lapses', async () => {
    const A = await actors();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) { await say(A, `n${i}`, false); ids.push(await bind(A, `n${i}`)); }

    // The ground moves under the NEWEST one — last in `sealed_at` order, and
    // the one the old implementation could never reach.
    await say(A, 'n24', true);

    // Batches smaller than the population, so the cursor has to advance.
    for (let pass = 0; pass < 6; pass++) await reevaluate(A.ws, 5);

    assert.equal(await stateOf(ids[24]!), 'lapsed',
      'the sweep must reach every determination, not the first batch forever');
    assert.equal(await stateOf(ids[0]!), 'sealed', 'and must not disturb the ones still holding');
  });

  test('the cursor advances on determinations that did NOT change', async () => {
    const A = await actors();
    for (let i = 0; i < 8; i++) { await say(A, `c${i}`, false); await bind(A, `c${i}`); }
    await reevaluate(A.ws, 3);

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM seals
        WHERE workspace_id = $1 AND last_evaluated_at IS NOT NULL AND NOT evaluation_due`,
      [A.ws]);
    assert.ok(Number(rows[0]!.n) >= 3,
      'examining a determination and leaving it alone is still examining it — '
      + 'if that is not recorded the sweep loops on its own head');
  });

  test('every determination is eventually examined', async () => {
    const A = await actors();
    for (let i = 0; i < 12; i++) { await say(A, `e${i}`, false); await bind(A, `e${i}`); }
    // Force them all due, as a fresh migration would.
    await getPool().query(
      'UPDATE seals SET evaluation_due = true, last_evaluated_at = NULL WHERE workspace_id = $1',
      [A.ws]);

    let guard = 0;
    for (;;) {
      const r = await reevaluate(A.ws, 4);
      if (r.remaining === 0) break;
      assert.ok(++guard < 20, 'the sweep is not making progress');
    }
    const lag = await sweepLag(getPool(), A.ws);
    assert.equal(lag.neverEvaluated, 0);
    assert.equal(lag.dueNow, 0);
  });

  test('remaining is reported, so a worker knows not to sleep on a backlog', async () => {
    const A = await actors();
    for (let i = 0; i < 10; i++) { await say(A, `r${i}`, false); await bind(A, `r${i}`); }
    await getPool().query(
      'UPDATE seals SET evaluation_due = true WHERE workspace_id = $1', [A.ws]);
    const r = await reevaluate(A.ws, 4);
    assert.equal(r.examined, 4);
    assert.equal(r.remaining, 6);
  });
});

/* ── Attestation freshness ───────────────────────────────────────────── */

describe("an expired attestation is UNKNOWN, not false", () => {
  test('a determination resting on a stale fact becomes tainted, never lapsed', async () => {
    const A = await actors();
    await say(A, 'x1', false, new Date(Date.now() + 3_600_000));
    const id = await bind(A, 'x1');

    await getPool().query(
      "UPDATE attestations SET expires_at = now() - interval '1 second' WHERE workspace_id = $1",
      [A.ws]);
    await getPool().query('UPDATE seals SET evaluation_due = true WHERE id = $1', [id]);
    await reevaluate(A.ws);

    assert.equal(await stateOf(id), 'tainted',
      'stale is not disproved — the ground is gone, and lapsing would be a guess');
  });

  test('a fresh determination cannot be sealed on a stale fact', async () => {
    const A = await actors();
    await say(A, 'x2', false, new Date(Date.now() + 3_600_000));
    await getPool().query(
      "UPDATE attestations SET expires_at = now() - interval '1 second' WHERE workspace_id = $1",
      [A.ws]);

    await assert.rejects(
      () => seal(A.agent, { idempotencyKey: 'idem-x2', aliases: person('x2'), scope: 'refund',
        disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'facts_not_attested',
          '42 CFR 435.916: if the data on hand is stale you may not determine from it');
        return true;
      });
  });

  test('an unexpired attestation is unaffected', async () => {
    const A = await actors();
    await say(A, 'x3', false, new Date(Date.now() + 3_600_000));
    const id = await bind(A, 'x3');
    await reevaluate(A.ws);
    assert.equal(await stateOf(id), 'sealed');
  });
});

/* ── Prompt correction ───────────────────────────────────────────────── */

describe('an attestation makes its determinations due', () => {
  test('a changed fact jumps the queue instead of waiting its turn', async () => {
    const A = await actors();
    for (let i = 0; i < 20; i++) { await say(A, `q${i}`, false); await bind(A, `q${i}`); }
    await reevaluate(A.ws);   // everything examined, nothing due

    const target = await bind(A, 'q19').catch(() => null);
    assert.equal(target, null, 'already sealed — replay, not a second determination');

    await say(A, 'q19', true);   // the ground moves under one of twenty
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM seals WHERE workspace_id = $1 AND evaluation_due', [A.ws]);
    assert.equal(Number(rows[0]!.n), 1, 'only the affected subject is marked due');

    // One tiny batch is enough, because due work sorts first.
    const r = await reevaluate(A.ws, 1);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0]?.to, 'lapsed');
  });
});

describe('every path that moves ground marks its determinations due', () => {
  test('erasure does, because it removes the ground rather than changing it', async () => {
    const { eraseSubject } = await import('../../src/domain/attest.js');
    const A = await actors();
    for (let i = 0; i < 6; i++) { await say(A, `d${i}`, false); await bind(A, `d${i}`); }
    await sweepOnce();   // nothing due

    const { rows } = await getPool().query<{ subject_id: string }>(
      'SELECT subject_id FROM seals WHERE workspace_id = $1 LIMIT 1', [A.ws]);
    await eraseSubject(A.ws, rows[0]!.subject_id);

    const { rows: due } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM seals WHERE workspace_id = $1 AND evaluation_due', [A.ws]);
    assert.ok(Number(due[0]!.n) >= 1,
      'an erasure is a legal event with a clock on it; the taint cannot wait for the cursor');

    const pass = await sweepOnce({ batchSize: 1, maxBatchesPerWorkspace: 1 });
    assert.equal(pass.changes[0]?.to, 'tainted',
      'and due work sorts first, so one tiny batch reaches it');
  });
});

/* ── The pass, and the lag it is measured by ─────────────────────────── */

describe('a sweep pass across workspaces', () => {
  test('only workspaces with due work are visited', async () => {
    const [A, B] = [await actors(), await actors()];
    await say(A, 'w1', false); await bind(A, 'w1');
    await say(B, 'w2', false); await bind(B, 'w2');
    await sweepOnce({ batchSize: 50 });

    await say(A, 'w1', true);   // only A has moved
    const pass = await sweepOnce({ batchSize: 50 });
    assert.equal(pass.workspaces, 1, 'an idle tenant costs nothing');
    assert.equal(pass.changes.length, 1);
    assert.equal(pass.changes[0]?.to, 'lapsed');
  });

  test('one large workspace cannot starve the pass', async () => {
    const A = await actors();
    for (let i = 0; i < 14; i++) { await say(A, `b${i}`, false); await bind(A, `b${i}`); }
    await getPool().query(
      'UPDATE seals SET evaluation_due = true WHERE workspace_id = $1', [A.ws]);

    const pass = await sweepOnce({ batchSize: 3, maxBatchesPerWorkspace: 2 });
    assert.equal(pass.examined, 6, 'bounded per workspace, per pass');
    assert.equal(pass.backlogged, 1, 'and the remainder is carried, not held');
  });

  test('sweep lag is a number, because "ongoing" has to be measurable', async () => {
    const A = await actors();
    for (let i = 0; i < 5; i++) { await say(A, `l${i}`, false); await bind(A, `l${i}`); }
    const before = await sweepLag(getPool(), A.ws);
    assert.equal(before.open, 5);
    assert.equal(before.dueNow, 0, 'a determination is evaluated at the moment it is sealed');

    await say(A, 'l0', true);
    assert.equal((await sweepLag(getPool(), A.ws)).dueNow, 1);
    await sweepOnce();
    const after = await sweepLag(getPool(), A.ws);
    assert.equal(after.dueNow, 0);
    assert.ok(after.oldestEvaluatedAt instanceof Date,
      '42 CFR 433.112(b)(15) wants evidence on an ongoing basis; this is how stale it is');
  });

  test('an expired determination is swept without anything being attested', async () => {
    const A = await actors();
    await say(A, 'z1', false);
    const id = await bind(A, 'z1');
    await sweepOnce();   // nothing due
    await expireSeal(id);

    // Nothing was attested, so no dirty flag was ever set. Time-driven work is
    // exactly why the cursor cannot be replaced by change tracking alone.
    const pass = await sweepOnce();
    assert.equal(pass.changes[0]?.to, 'expired');
    assert.equal(await stateOf(id), 'expired');
  });
});
