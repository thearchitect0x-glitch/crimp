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
import { seal, lookup, reevaluate, sweepLag, SYNC_REEXECUTION_CAP } from '../../src/domain/seal.js';
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

describe('fact expiry is a change nothing writes', () => {
  test('a determination standing on an attestation that ran out is re-examined without any write, and only once', async () => {
    const A = await actors();
    await say(A, 'fade', false, new Date(Date.now() + 400));
    const id = await bind(A, 'fade');
    assert.equal(await stateOf(id), 'sealed');
    await new Promise((r) => setTimeout(r, 600));
    // Nothing was written for this subject, so nothing in this workspace is
    // due and the pass would not even open a batch here. Before the third
    // trigger this determination stayed sealed on evidence its owner had
    // declared stale. Through the worker's own pass, not a batch by hand.
    const r = await sweepOnce();
    assert.ok(r.changes.some((c) => c.sealId === id && c.to === 'tainted'), 'the expiry alone reached it');
    assert.equal(await stateOf(id), 'tainted');
    const again = await reevaluate(A.ws);
    assert.equal(again.examined, 0, 'the examination moved the cursor past the expiry');
  });

  test('a determination past its own expiry is recorded even while due work fills every batch', async () => {
    const A = await actors();
    const past: string[] = [];
    for (const t of ['x1', 'x2', 'x3']) { await say(A, t, false); past.push(await bind(A, t)); }
    for (const id of past) await expireSeal(id);
    // Thirty determinations due: three times the batch. (Set directly — a
    // write would correct them in place before the pass.)
    for (let i = 0; i < 30; i++) { await say(A, `d${i}`, false); await bind(A, `d${i}`); }
    await getPool().query('UPDATE seals SET evaluation_due = true WHERE workspace_id = $1 AND id <> ALL($2::text[])', [A.ws, past]);
    const r = await reevaluate(A.ws, 10);
    assert.equal(r.examined, 10);
    const states = await Promise.all(past.map((id) => stateOf(id)));
    assert.ok(states.includes('expired'), `the reserved share reached an expired determination in a full batch: ${states}`);
  });
});

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

describe('an attestation corrects its determinations at the moment of the write', () => {
  test('a changed fact lapses the refusal in the same call, before any pass', async () => {
    const A = await actors();
    for (let i = 0; i < 20; i++) { await say(A, `q${i}`, false); await bind(A, `q${i}`); }
    await reevaluate(A.ws);   // everything examined, nothing due

    const target = await bind(A, 'q19').catch(() => null);
    assert.equal(target, null, 'already sealed — replay, not a second determination');

    const ids = await getPool().query<{ id: string }>(
      `SELECT id FROM seals WHERE workspace_id = $1 ORDER BY sealed_at DESC LIMIT 1`, [A.ws]);
    await say(A, 'q19', true);   // the ground moves under one of twenty
    // The write itself corrected it: the fact and its consequence committed together.
    assert.equal(await stateOf(ids.rows[0]!.id), 'lapsed');
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM seals WHERE workspace_id = $1 AND evaluation_due', [A.ws]);
    assert.equal(Number(rows[0]!.n), 0, 'nothing is left for the sweep');
    const r = await reevaluate(A.ws, 1);
    assert.equal(r.changes.length, 0, 'and the sweep finds nothing to do');
  });

  test('the lapsed event says what moved — fact, source, class, pressure — and never a value', async () => {
    const A = await actors();
    await say(A, 'w', false);
    const id = await bind(A, 'w');
    for (let i = 0; i < 3; i++) await lookup(A.agent, { aliases: person('w'), scope: 'refund', session: 'a'.repeat(32) }, STRENGTHS);
    await attest(A.agent, { aliases: person('w'), facts: [
      { fact: 'carrier.delivered', type: 'bool', value: true, source: 'state_registry' } ] }, STRENGTHS);
    assert.equal(await stateOf(id), 'lapsed');
    const { rows } = await getPool().query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'lapsed'`, [id]);
    const d = rows[0]!.detail;
    assert.deepEqual(d['changed'], [{ fact: 'carrier.delivered', was: { source: 'carrier_api', admissibility: 'receipt' },
      now: { source: 'state_registry', admissibility: 'authority' } }]);
    assert.deepEqual(d['pressure'], { attempts: 3, sessions: 1 });
    assert.equal(JSON.stringify(d).includes('"value"'), false, 'no value on the event');
  });

  test('more determinations than the cap: the write corrects the cap, the sweep the rest', async () => {
    const A = await actors();
    await say(A, 'many', false);
    const ids: string[] = [];
    for (let i = 0; i < SYNC_REEXECUTION_CAP + 3; i++) {
      const r = await seal(A.agent, { idempotencyKey: `idem-many-${i}`, aliases: person('many'),
        scope: `refund.line${i}`, disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
      ids.push(r.sealId!);
    }
    await say(A, 'many', true);
    const states = await Promise.all(ids.map((id) => stateOf(id)));
    assert.equal(states.filter((x) => x === 'lapsed').length, SYNC_REEXECUTION_CAP, 'the cap, at the write');
    await reevaluate(A.ws);
    const after = await Promise.all(ids.map((id) => stateOf(id)));
    assert.equal(after.filter((x) => x === 'lapsed').length, ids.length, 'the sweep finishes the rest');
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

    // An erasure is a legal event with a clock on it. The taint does not wait
    // for the cursor, nor for the next pass: it is recorded by the erasure.
    const { rows: st } = await getPool().query<{ state: string }>(
      'SELECT state FROM seals WHERE workspace_id = $1 AND subject_id = $2', [A.ws, rows[0]!.subject_id]);
    assert.equal(st[0]?.state, 'tainted', 'tainted by the erasure itself');
    const pass = await sweepOnce({ batchSize: 1, maxBatchesPerWorkspace: 1 });
    assert.equal(pass.changes.some((c) => c.to === 'tainted'), false, 'nothing left for the pass');
  });
});

/* ── The pass, and the lag it is measured by ─────────────────────────── */

describe('a sweep pass across workspaces', () => {
  test('only workspaces with due work are visited', async () => {
    const [A, B] = [await actors(), await actors()];
    await say(A, 'w1', false); await bind(A, 'w1');
    await say(B, 'w2', false); await bind(B, 'w2');
    await sweepOnce({ batchSize: 50 });

    // Only A has due work. (A write would now correct it in place, so the
    // due flag is set directly: this test is about who the pass visits.)
    await getPool().query('UPDATE seals SET evaluation_due = true WHERE workspace_id = $1', [A.ws]);
    const pass = await sweepOnce({ batchSize: 50 });
    assert.equal(pass.workspaces, 1, 'an idle tenant costs nothing');
    assert.equal(pass.examined, 1);
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
    // Corrected at the write, so nothing is due afterwards.
    assert.equal((await sweepLag(getPool(), A.ws)).dueNow, 0);
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


describe('breadth: one session across many people', () => {
  test('is a finding about the session, and no determination is hardened', async () => {
    const A = await actors();
    const { probingBreadth, BREADTH } = await import('../../src/domain/breadth.js');
    const { listFindings } = await import('../../src/domain/findings.js');
    const session = 'b'.repeat(32);
    for (let i = 0; i < BREADTH.distinctDeterminations; i++) {
      await say(A, `p${i}`, false); await bind(A, `p${i}`);
      await lookup(A.agent, { aliases: person(`p${i}`), scope: 'refund', session }, STRENGTHS);
    }
    assert.equal(await probingBreadth(getPool()), 1);
    const found = await listFindings(A.operator, { class: 'probing_breadth' });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.subjectKind, 'session');
    assert.equal(found[0]?.subjectId, session);
    assert.equal(found[0]?.detail['determinations'], BREADTH.distinctDeterminations);
    assert.equal(await probingBreadth(getPool()), 0, 'once per session per day');
    // One refusal each: no determination reached a tier that hardens.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM seal_events WHERE workspace_id = $1 AND kind = 'hardened'`, [A.ws]);
    assert.equal(Number(rows[0]!.n), 0);
  });
});
