// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest, eraseSubject } from '../../src/domain/attest.js';
import { seal, lookup, exercise, claw, reevaluate, pressureOf, CODES } from '../../src/domain/seal.js';
import { tierOf } from '../../src/domain/lifecycle.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, countEvents, stateOf, ageSeal, hash64, STRENGTHS,
  type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    return true;
  }, why);
}

/** Attest the facts RULE reads, so it evaluates TRUE. */
async function setup(A: Actors, tag: string, opts: { delivered?: boolean; refunds?: number } = {}) {
  await attest(A.agent, { aliases: person(tag),
    facts: [
      { fact: 'carrier.delivered', type: 'bool', value: opts.delivered ?? false, source: 'carrier_api' },
      { fact: 'prior_refunds_90d', type: 'int', value: opts.refunds ?? 1, source: 'core_ledger' },
    ],
  }, STRENGTHS);
}

describe('seal', () => {
  test('creates a determination when the rule holds', async () => {
    const A = await actors();
    await setup(A, 'a1');
    const out = await seal(A.agent, { idempotencyKey: 'idem-a1', aliases: person('a1'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, claw: CLAW,
    }, STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    assert.ok(out.sealId);
    assert.match(out.ruleHash, /^[0-9a-f]{64}$/);
    assert.equal(await countEvents(out.sealId!, 'sealed'), 1);
  });

  test('records what the seal rested on, with source and admissibility', async () => {
    const A = await actors();
    await setup(A, 'a2');
    const out = await seal(A.agent, { idempotencyKey: 'idem-a2', aliases: person('a2'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, claw: CLAW,
    }, STRENGTHS);
    const { rows } = await getPool().query<{ fact: string; source: string; admissibility: string; value_sha256: string }>(
      'SELECT fact, source, admissibility, value_sha256 FROM seal_facts WHERE seal_id = $1 ORDER BY fact',
      [out.sealId]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.source, 'carrier_api');
    assert.equal(rows[0]?.admissibility, 'receipt');
    assert.match(rows[0]?.value_sha256 ?? '', /^[0-9a-f]{64}$/,
      'the commitment, never the raw historical value');
  });

  test('a rule that does not hold creates nothing — and that is not an error', async () => {
    const A = await actors();
    await setup(A, 'a3', { refunds: 9 });   // prior_refunds_90d < 3 is false
    const out = await seal(A.agent, { idempotencyKey: 'idem-a3', aliases: person('a3'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, claw: CLAW,
    }, STRENGTHS);
    assert.equal(out.outcome, 'not_applicable');
    assert.equal(out.sealId, null);
  });

  test('refuses to seal on facts the agent never gathered', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('a4'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-a4', aliases: person('a4'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, claw: CLAW,
    }, STRENGTHS), 'facts_not_attested', 'prior_refunds_90d was never attested');
  });

  test('refuses a rule that ignores a fact class policy requires', async () => {
    const A = await actors();
    await setup(A, 'a5');
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-a5', aliases: person('a5'), scope: 'refund.issue',
      disposition: 'bind', rule: { fact: 'carrier.delivered', op: 'eq', value: false }, claw: CLAW, requiredFacts: ['prior_refunds_90d'],
    }, STRENGTHS), 'rule_missing_required_fact', 'the vacuous-rule defence');
  });

  test('an agent cannot declare a claw rule beyond an operator', async () => {
    const A = await actors();
    await setup(A, 'a6');
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-a6', aliases: person('a6'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE,
      claw: { ...CLAW, authority: 'custodian' },
    }, STRENGTHS), 'invalid_claw_rule', 'blast-radius cap enforced end to end');
  });
});

describe('lookup', () => {
  test('a subject nobody has decided about yields nothing', async () => {
    const A = await actors();
    const out = await lookup(A.agent, { aliases: person('b0'), scope: 'refund.issue' }, STRENGTHS);
    assert.deepEqual(out.determinations, [],
      'empty means nothing has been decided — it does not mean allowed, and there '
      + 'is no token because Crimp does not authorise anything');
  });

  test('a bind refuses, and a broader seal covers a narrower action', async () => {
    const A = await actors();
    await setup(A, 'b1');
    await seal(A.agent, { idempotencyKey: 'idem-b1', aliases: person('b1'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    const narrow = await lookup(A.agent, { aliases: person('b1'),
      scope: 'refund.issue.goodwill' }, STRENGTHS);
    assert.equal(narrow.determinations.length, 1);
    assert.equal(narrow.determinations[0]?.code, CODES.refusalStanding);
    assert.equal(narrow.determinations[0]?.scope, 'refund', 'reports which seal reaches it');
  });

  test('a narrow seal does not bind a broader action', async () => {
    const A = await actors();
    await setup(A, 'b2');
    await seal(A.agent, { idempotencyKey: 'idem-b2', aliases: person('b2'), scope: 'refund.issue.goodwill',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    const broad = await lookup(A.agent, { aliases: person('b2'), scope: 'refund' }, STRENGTHS);
    assert.deepEqual(broad.determinations, [],
      'refusing one way of refunding is not refusing all of them');
  });

  test('a fresh alias presenting a known card is still bound', async () => {
    const A = await actors();
    await setup(A, 'b3');
    await seal(A.agent, { idempotencyKey: 'idem-b3', aliases: person('b3'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    const out = await lookup(A.agent, { scope: 'refund.issue', aliases: [
      { type: 'card_fp', value: 'card-b3' },
      { type: 'email', value: 'brand-new@example.com' },
    ] }, STRENGTHS);
    assert.equal(out.determinations[0]?.code, CODES.refusalStanding,
      'you cannot get a new answer by getting a new email address');
  });

  test('ASKING about a permit does not spend it', async () => {
    const A = await actors();
    await setup(A, 'b4');
    const s = await seal(A.operator, { idempotencyKey: 'idem-b4', aliases: person('b4'), scope: 'goodwill.credit',
      disposition: 'permit', rule: RULE, maxUses: 1,
      claw: { ...CLAW, authority: 'principal' } }, STRENGTHS);

    // An earlier design consumed a use on every check, so a caller finding out
    // whether a one-time grant was available destroyed it in the process.
    for (let i = 0; i < 5; i++) {
      const q = await lookup(A.agent, { aliases: person('b4'), scope: 'goodwill.credit' }, STRENGTHS);
      assert.equal(q.determinations[0]?.code, CODES.permitAvailable);
      assert.equal(q.determinations[0]?.remaining, 1, 'still one, after five questions');
    }
    assert.equal(await countEvents(s.sealId!, 'exercised'), 0);
  });

  test('a permit is spent exactly max_uses times, and only when spent on purpose', async () => {
    const A = await actors();
    await setup(A, 'b4b');
    const s = await seal(A.operator, { idempotencyKey: 'idem-b4b',
      aliases: person('b4b'), scope: 'goodwill.credit',
      disposition: 'permit', rule: RULE, maxUses: 1,
      claw: { ...CLAW, authority: 'principal' } }, STRENGTHS);

    const first = await exercise(A.agent, { sealId: s.sealId! });
    assert.equal(first.exercised, true);
    assert.equal(first.remaining, 0);

    const second = await exercise(A.agent, { sealId: s.sealId! });
    assert.equal(second.exercised, false);
    assert.equal(second.code, CODES.permitExhausted,
      'the same one-time grant issued twice is the loss this prevents');
    assert.equal(await countEvents(s.sealId!, 'exercised'), 1);

    const q = await lookup(A.agent, { aliases: person('b4b'), scope: 'goodwill.credit' }, STRENGTHS);
    assert.equal(q.determinations[0]?.code, CODES.permitExhausted);
    assert.equal(q.determinations[0]?.remaining, 0);
  });

  test('concurrent callers cannot both win the last use', async () => {
    const A = await actors();
    await setup(A, 'b5');
    await seal(A.operator, { idempotencyKey: 'idem-b5', aliases: person('b5'), scope: 'goodwill.credit',
      disposition: 'permit', rule: RULE, maxUses: 1,
      claw: { ...CLAW, authority: 'principal' } }, STRENGTHS);

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM seals WHERE workspace_id = $1 AND disposition = 'permit'`, [A.ws]);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      exercise(A.agent, { sealId: rows[0]!.id })));
    assert.equal(results.filter((r) => r.exercised).length, 1,
      'at-most-N is enforced by the database, not by application logic');
  });

  test('workspaces are isolated', async () => {
    const [A, B] = [await actors(), await actors()];
    await setup(A, 'b6');
    await seal(A.agent, { idempotencyKey: 'idem-b6', aliases: person('b6'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    const other = await lookup(B.agent, { aliases: person('b6'), scope: 'refund' }, STRENGTHS);
    assert.deepEqual(other.determinations, [], 'the workspace id is inside the alias MAC');
  });
});

describe('pressure', () => {
  test('a refusal is counted; a clear check is not', async () => {
    const A = await actors();
    await setup(A, 'c1');
    const s = await seal(A.agent, { idempotencyKey: 'idem-c1', aliases: person('c1'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    for (let i = 0; i < 4; i++) {
      await lookup(A.agent, { aliases: person('c1'), scope: 'refund.issue',
        session: 'a'.repeat(32) }, STRENGTHS);
    }
    const p = await pressureOf(getPool(), s.sealId!);
    assert.equal(p.attempts, 4);
    assert.equal(p.sessions, 1);
    assert.equal(tierOf(p), 'persistent');
  });

  test('distinct sessions are what separate probing from persistence', async () => {
    const A = await actors();
    await setup(A, 'c2');
    const s = await seal(A.agent, { idempotencyKey: 'idem-c2', aliases: person('c2'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    for (let sess = 0; sess < 4; sess++) {
      for (let i = 0; i < 4; i++) {
        await lookup(A.agent, { aliases: person('c2'), scope: 'refund.issue',
          session: String(sess).repeat(32).slice(0, 32) }, STRENGTHS);
      }
    }
    const p = await pressureOf(getPool(), s.sealId!);
    assert.equal(p.attempts, 16);
    assert.equal(p.sessions, 4);
    assert.equal(tierOf(p), 'probing');
  });
});

describe('claw', () => {
  async function sealed(tag: string, cl: Partial<ClawRule> = {}) {
    const A = await actors();
    await setup(A, tag);
    const s = await seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: { ...CLAW, ...cl } }, STRENGTHS);
    return { A, sealId: s.sealId! };
  }

  test('an agent cannot lift what it sealed', async () => {
    const { A, sealId } = await sealed('d1');
    await refuses(() => claw(A.agent, { sealId,
      evidenceSha256: hash64('e'), evidenceClass: 'internal' }),
    'insufficient_authority', 'the sentence the product is sold on');
    assert.equal(await stateOf(sealId), 'sealed');
  });

  test('self-asserted evidence cannot meet a disinterested floor', async () => {
    const { A, sealId } = await sealed('d2', { evidenceFloor: 'receipt' });
    for (const cls of ['self', 'signed'] as const) {
      await refuses(() => claw(A.operator, { sealId,
        evidenceSha256: hash64('e'), evidenceClass: cls }),
      'insufficient_evidence', `${cls} must not clear a receipt floor`);
    }
  });

  test('cooling-off cannot be argued with', async () => {
    const { A, sealId } = await sealed('d3', { coolingOffSeconds: 3600 });
    await refuses(() => claw(A.operator, { sealId,
      evidenceSha256: hash64('e'), evidenceClass: 'internal' }),
    'cooling_off', 'you cannot talk time into passing');

    await ageSeal(sealId, 3700);
    const out = await claw(A.operator, { sealId,
      evidenceSha256: hash64('e'), evidenceClass: 'internal' });
    assert.equal(out.state, 'clawed');
  });

  test('a successful claw records who, on what evidence — and deletes nothing', async () => {
    const { A, sealId } = await sealed('d4');
    await claw(A.operator, { sealId,
      evidenceSha256: hash64('proof'), evidenceClass: 'receipt' });
    assert.equal(await stateOf(sealId), 'clawed', 'the seal still exists');
    const { rows } = await getPool().query<{ actor: string; evidence_class: string; evidence_sha256: string }>(
      `SELECT actor, evidence_class, evidence_sha256 FROM seal_events
        WHERE seal_id = $1 AND kind = 'clawed'`, [sealId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor, 'operator');
    assert.equal(rows[0]?.evidence_class, 'receipt');
  });

  test('a clawed seal no longer binds, and cannot be clawed twice', async () => {
    const { A, sealId } = await sealed('d5');
    await claw(A.operator, { sealId,
      evidenceSha256: hash64('p'), evidenceClass: 'internal' });
    const after = await lookup(A.agent, { aliases: person('d5'), scope: 'refund.issue' }, STRENGTHS);
    assert.deepEqual(after.determinations, []);
    await refuses(() => claw(A.operator, { sealId,
      evidenceSha256: hash64('p'), evidenceClass: 'internal' }), 'already_settled', 'double claw');
  });

  test('a cross-tenant claw is a 404, never a hint that the seal exists', async () => {
    const { sealId } = await sealed('d6');
    const Other = await actors();
    await refuses(() => claw(Other.custodian, { sealId,
      evidenceSha256: hash64('p'), evidenceClass: 'authority' }), 'not_found', 'tenant isolation');
  });

  test('PRESSURE HARDENING: a probed seal demands a higher authority', async () => {
    const { A, sealId } = await sealed('d7');
    for (let sess = 0; sess < 4; sess++) {
      for (let i = 0; i < 4; i++) {
        await lookup(A.agent, { aliases: person('d7'), scope: 'refund.issue',
          session: String(sess).repeat(32).slice(0, 32) }, STRENGTHS);
      }
    }
    // The declared rule said `operator`. Probing promoted it out of reach.
    await refuses(() => claw(A.operator, { sealId,
      evidenceSha256: hash64('p'), evidenceClass: 'receipt' }),
    'insufficient_authority', "the attacker's own effort locked the door");

    const out = await claw(A.principal, { sealId,
      evidenceSha256: hash64('p'), evidenceClass: 'receipt' });
    assert.equal(out.state, 'clawed');
  });
});

describe('re-evaluation — the unbiased correction channel', () => {
  test('a seal whose rule still holds is left alone', async () => {
    const A = await actors();
    const ws = A.ws;
    await setup(A, 'e1');
    const s = await seal(A.agent, { idempotencyKey: 'idem-e1', aliases: person('e1'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    assert.deepEqual((await reevaluate(ws)).changes, []);
    assert.equal(await stateOf(s.sealId!), 'sealed');
  });

  test('LAPSE: the ground gives way and nobody had to complain', async () => {
    const A = await actors();
    const ws = A.ws;
    await setup(A, 'e2');
    const s = await seal(A.agent, { idempotencyKey: 'idem-e2', aliases: person('e2'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    // The carrier reverses its delivery scan. Nobody appealed; nobody was asked.
    await attest(A.agent, { aliases: person('e2'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: true, source: 'carrier_api' }] },
    STRENGTHS);

    // Corrected by the carrier's own write, before any pass ran.
    assert.equal(await stateOf(s.sealId!), 'lapsed');
    assert.equal(await countEvents(s.sealId!, 'lapsed'), 1);
    const { changes } = await reevaluate(ws);
    assert.deepEqual(changes, [], 'the pass found it already corrected');

    const after = await lookup(A.agent, { aliases: person('e2'), scope: 'refund.issue' }, STRENGTHS);
    assert.deepEqual(after.determinations, [],
      'a lapsed determination stops standing, with no authority involved');
  });

  test('TAINT: losing the ability to check is not discovering you were wrong', async () => {
    const A = await actors();
    const ws = A.ws;
    await setup(A, 'e3');
    const s = await seal(A.agent, { idempotencyKey: 'idem-e3', aliases: person('e3'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    const { rows } = await getPool().query<{ subject_id: string }>(
      'SELECT subject_id FROM seals WHERE id = $1', [s.sealId]);
    await eraseSubject(ws, rows[0]!.subject_id);

    // Tainted by the erasure itself; the pass has nothing left.
    assert.equal(await stateOf(s.sealId!), 'tainted');
    assert.equal(await countEvents(s.sealId!, 'tainted'), 1);
    const { changes } = await reevaluate(ws);
    assert.deepEqual(changes, []);

    const after = await lookup(A.agent, { aliases: person('e3'), scope: 'refund.issue' }, STRENGTHS);
    assert.equal(after.determinations[0]?.code, CODES.refusalTainted,
      'a tainted seal still stands — lifting on an unknown is a guess');
  });

  test('erasure destroys nothing the proof rests on', async () => {
    const A = await actors();
    const ws = A.ws;
    await setup(A, 'e4');
    const s = await seal(A.agent, { idempotencyKey: 'idem-e4', aliases: person('e4'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    const { rows } = await getPool().query<{ subject_id: string }>(
      'SELECT subject_id FROM seals WHERE id = $1', [s.sealId]);

    await eraseSubject(ws, rows[0]!.subject_id);

    const { rows: facts } = await getPool().query(
      'SELECT value_sha256 FROM seal_facts WHERE seal_id = $1', [s.sealId]);
    assert.equal(facts.length, 2, 'the commitments survive; only the current values were deleted');
  });
});
