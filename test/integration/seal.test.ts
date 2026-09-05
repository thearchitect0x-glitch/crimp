// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest, eraseSubject } from '../../src/domain/attest.js';
import { seal, check, claw, reevaluate, pressureOf } from '../../src/domain/seal.js';
import { tierOf } from '../../src/domain/lifecycle.js';
import { ApiError } from '../../src/lib/errors.js';
import { freshWorkspace, person, countEvents, stateOf, ageSeal, hash64, STRENGTHS } from '../helpers.js';
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
async function setup(ws: string, tag: string, opts: { delivered?: boolean; refunds?: number } = {}) {
  await attest({
    workspaceId: ws,
    aliases: person(tag),
    facts: [
      { fact: 'carrier.delivered', type: 'bool', value: opts.delivered ?? false, source: 'carrier_api' },
      { fact: 'prior_refunds_90d', type: 'int', value: opts.refunds ?? 1, source: 'core_ledger' },
    ],
  }, STRENGTHS);
}

describe('seal', () => {
  test('creates a determination when the rule holds', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'a1');
    const out = await seal({
      workspaceId: ws, aliases: person('a1'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW,
    }, STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    assert.ok(out.sealId);
    assert.match(out.ruleHash, /^[0-9a-f]{64}$/);
    assert.equal(await countEvents(out.sealId!, 'sealed'), 1);
  });

  test('records what the seal rested on, with source and admissibility', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'a2');
    const out = await seal({
      workspaceId: ws, aliases: person('a2'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW,
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
    const ws = await freshWorkspace();
    await setup(ws, 'a3', { refunds: 9 });   // prior_refunds_90d < 3 is false
    const out = await seal({
      workspaceId: ws, aliases: person('a3'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW,
    }, STRENGTHS);
    assert.equal(out.outcome, 'not_applicable');
    assert.equal(out.sealId, null);
  });

  test('refuses to seal on facts the agent never gathered', async () => {
    const ws = await freshWorkspace();
    await attest({ workspaceId: ws, aliases: person('a4'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);
    await refuses(() => seal({
      workspaceId: ws, aliases: person('a4'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW,
    }, STRENGTHS), 'facts_not_attested', 'prior_refunds_90d was never attested');
  });

  test('refuses a rule that ignores a fact class policy requires', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'a5');
    await refuses(() => seal({
      workspaceId: ws, aliases: person('a5'), scope: 'refund.issue',
      disposition: 'bind', rule: { fact: 'carrier.delivered', op: 'eq', value: false },
      sealedBy: 'agent', claw: CLAW, requiredFacts: ['prior_refunds_90d'],
    }, STRENGTHS), 'rule_missing_required_fact', 'the vacuous-rule defence');
  });

  test('an agent cannot declare a claw rule beyond an operator', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'a6');
    await refuses(() => seal({
      workspaceId: ws, aliases: person('a6'), scope: 'refund.issue',
      disposition: 'bind', rule: RULE, sealedBy: 'agent',
      claw: { ...CLAW, authority: 'custodian' },
    }, STRENGTHS), 'invalid_claw_rule', 'blast-radius cap enforced end to end');
  });
});

describe('check', () => {
  test('a subject nobody has decided about is not bound', async () => {
    const ws = await freshWorkspace();
    const out = await check({ workspaceId: ws, aliases: person('b0'), scope: 'refund.issue' }, STRENGTHS);
    assert.equal(out.bound, false);
    assert.equal(out.reason, 'no_determination');
    assert.ok(out.bindingToken, 'the gate needs a token when nothing binds');
  });

  test('a bind refuses, and a broader seal covers a narrower action', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'b1');
    await seal({ workspaceId: ws, aliases: person('b1'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);

    const narrow = await check({ workspaceId: ws, aliases: person('b1'),
      scope: 'refund.issue.goodwill' }, STRENGTHS);
    assert.equal(narrow.bound, true);
    assert.equal(narrow.reason, 'bound.refusal_standing');
    assert.equal(narrow.bindingToken, undefined, 'no token is issued when bound');
  });

  test('a narrow seal does not bind a broader action', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'b2');
    await seal({ workspaceId: ws, aliases: person('b2'), scope: 'refund.issue.goodwill',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);
    const broad = await check({ workspaceId: ws, aliases: person('b2'), scope: 'refund' }, STRENGTHS);
    assert.equal(broad.bound, false, 'refusing one way of refunding is not refusing all of them');
  });

  test('a fresh alias presenting a known card is still bound', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'b3');
    await seal({ workspaceId: ws, aliases: person('b3'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);

    const out = await check({ workspaceId: ws, scope: 'refund.issue', aliases: [
      { type: 'card_fp', value: 'card-b3' },
      { type: 'email', value: 'brand-new@example.com' },
    ] }, STRENGTHS);
    assert.equal(out.bound, true, 'you cannot get a new answer by getting a new email address');
  });

  test('a permit is spent exactly max_uses times', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'b4');
    const s = await seal({ workspaceId: ws, aliases: person('b4'), scope: 'goodwill.credit',
      disposition: 'permit', rule: RULE, sealedBy: 'operator', maxUses: 1,
      claw: { ...CLAW, authority: 'principal' } }, STRENGTHS);

    const first = await check({ workspaceId: ws, aliases: person('b4'), scope: 'goodwill.credit' }, STRENGTHS);
    assert.equal(first.bound, false);
    assert.equal(first.reason, 'permit.exercised');

    const second = await check({ workspaceId: ws, aliases: person('b4'), scope: 'goodwill.credit' }, STRENGTHS);
    assert.equal(second.bound, true);
    assert.equal(second.reason, 'permit.already_exercised',
      'the same one-time grant issued twice is the loss this prevents');
    assert.equal(await countEvents(s.sealId!, 'exercised'), 1);
  });

  test('concurrent callers cannot both win the last use', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'b5');
    await seal({ workspaceId: ws, aliases: person('b5'), scope: 'goodwill.credit',
      disposition: 'permit', rule: RULE, sealedBy: 'operator', maxUses: 1,
      claw: { ...CLAW, authority: 'principal' } }, STRENGTHS);

    const results = await Promise.all(Array.from({ length: 8 }, () =>
      check({ workspaceId: ws, aliases: person('b5'), scope: 'goodwill.credit' }, STRENGTHS)));
    const granted = results.filter((r) => r.reason === 'permit.exercised');
    assert.equal(granted.length, 1,
      'at-most-N is enforced by the database, not by application logic');
  });

  test('workspaces are isolated', async () => {
    const [a, b] = [await freshWorkspace(), await freshWorkspace()];
    await setup(a, 'b6');
    await seal({ workspaceId: a, aliases: person('b6'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);
    const other = await check({ workspaceId: b, aliases: person('b6'), scope: 'refund' }, STRENGTHS);
    assert.equal(other.bound, false, 'the workspace id is inside the alias MAC');
  });
});

describe('pressure', () => {
  test('a refusal is counted; a clear check is not', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'c1');
    const s = await seal({ workspaceId: ws, aliases: person('c1'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);

    for (let i = 0; i < 4; i++) {
      await check({ workspaceId: ws, aliases: person('c1'), scope: 'refund.issue',
        session: 'a'.repeat(32) }, STRENGTHS);
    }
    const p = await pressureOf(getPool(), s.sealId!);
    assert.equal(p.attempts, 4);
    assert.equal(p.sessions, 1);
    assert.equal(tierOf(p), 'persistent');
  });

  test('distinct sessions are what separate probing from persistence', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'c2');
    const s = await seal({ workspaceId: ws, aliases: person('c2'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);

    for (let sess = 0; sess < 4; sess++) {
      for (let i = 0; i < 4; i++) {
        await check({ workspaceId: ws, aliases: person('c2'), scope: 'refund.issue',
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
    const ws = await freshWorkspace();
    await setup(ws, tag);
    const s = await seal({ workspaceId: ws, aliases: person(tag), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: { ...CLAW, ...cl } }, STRENGTHS);
    return { ws, sealId: s.sealId! };
  }

  test('an agent cannot lift what it sealed', async () => {
    const { ws, sealId } = await sealed('d1');
    await refuses(() => claw({ workspaceId: ws, sealId, actor: 'agent',
      evidenceSha256: hash64('e'), evidenceClass: 'internal' }),
    'insufficient_authority', 'the sentence the product is sold on');
    assert.equal(await stateOf(sealId), 'sealed');
  });

  test('self-asserted evidence cannot meet a disinterested floor', async () => {
    const { ws, sealId } = await sealed('d2', { evidenceFloor: 'receipt' });
    for (const cls of ['self', 'signed'] as const) {
      await refuses(() => claw({ workspaceId: ws, sealId, actor: 'operator',
        evidenceSha256: hash64('e'), evidenceClass: cls }),
      'insufficient_evidence', `${cls} must not clear a receipt floor`);
    }
  });

  test('cooling-off cannot be argued with', async () => {
    const { ws, sealId } = await sealed('d3', { coolingOffSeconds: 3600 });
    await refuses(() => claw({ workspaceId: ws, sealId, actor: 'operator',
      evidenceSha256: hash64('e'), evidenceClass: 'internal' }),
    'cooling_off', 'you cannot talk time into passing');

    await ageSeal(sealId, 3700);
    const out = await claw({ workspaceId: ws, sealId, actor: 'operator',
      evidenceSha256: hash64('e'), evidenceClass: 'internal' });
    assert.equal(out.state, 'clawed');
  });

  test('a successful claw records who, on what evidence — and deletes nothing', async () => {
    const { ws, sealId } = await sealed('d4');
    await claw({ workspaceId: ws, sealId, actor: 'operator',
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
    const { ws, sealId } = await sealed('d5');
    await claw({ workspaceId: ws, sealId, actor: 'operator',
      evidenceSha256: hash64('p'), evidenceClass: 'internal' });
    const after = await check({ workspaceId: ws, aliases: person('d5'), scope: 'refund.issue' }, STRENGTHS);
    assert.equal(after.bound, false);
    await refuses(() => claw({ workspaceId: ws, sealId, actor: 'operator',
      evidenceSha256: hash64('p'), evidenceClass: 'internal' }), 'already_settled', 'double claw');
  });

  test('a cross-tenant claw is a 404, never a hint that the seal exists', async () => {
    const { sealId } = await sealed('d6');
    const other = await freshWorkspace();
    await refuses(() => claw({ workspaceId: other, sealId, actor: 'custodian',
      evidenceSha256: hash64('p'), evidenceClass: 'authority' }), 'not_found', 'tenant isolation');
  });

  test('PRESSURE HARDENING: a probed seal demands a higher authority', async () => {
    const { ws, sealId } = await sealed('d7');
    for (let sess = 0; sess < 4; sess++) {
      for (let i = 0; i < 4; i++) {
        await check({ workspaceId: ws, aliases: person('d7'), scope: 'refund.issue',
          session: String(sess).repeat(32).slice(0, 32) }, STRENGTHS);
      }
    }
    // The declared rule said `operator`. Probing promoted it out of reach.
    await refuses(() => claw({ workspaceId: ws, sealId, actor: 'operator',
      evidenceSha256: hash64('p'), evidenceClass: 'receipt' }),
    'insufficient_authority', "the attacker's own effort locked the door");

    const out = await claw({ workspaceId: ws, sealId, actor: 'principal',
      evidenceSha256: hash64('p'), evidenceClass: 'receipt' });
    assert.equal(out.state, 'clawed');
  });
});

describe('re-evaluation — the unbiased correction channel', () => {
  test('a seal whose rule still holds is left alone', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'e1');
    const s = await seal({ workspaceId: ws, aliases: person('e1'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);
    assert.deepEqual(await reevaluate(ws), []);
    assert.equal(await stateOf(s.sealId!), 'sealed');
  });

  test('LAPSE: the ground gives way and nobody had to complain', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'e2');
    const s = await seal({ workspaceId: ws, aliases: person('e2'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);

    // The carrier reverses its delivery scan. Nobody appealed; nobody was asked.
    await attest({ workspaceId: ws, aliases: person('e2'),
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: true, source: 'carrier_api' }] },
    STRENGTHS);

    const changes = await reevaluate(ws);
    assert.deepEqual(changes, [{ sealId: s.sealId!, from: 'sealed', to: 'lapsed' }]);
    assert.equal(await stateOf(s.sealId!), 'lapsed');
    assert.equal(await countEvents(s.sealId!, 'lapsed'), 1);

    const after = await check({ workspaceId: ws, aliases: person('e2'), scope: 'refund.issue' }, STRENGTHS);
    assert.equal(after.bound, false, 'a lapsed determination stops binding, with no authority involved');
  });

  test('TAINT: losing the ability to check is not discovering you were wrong', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'e3');
    const s = await seal({ workspaceId: ws, aliases: person('e3'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);

    const { rows } = await getPool().query<{ subject_id: string }>(
      'SELECT subject_id FROM seals WHERE id = $1', [s.sealId]);
    await eraseSubject(ws, rows[0]!.subject_id);

    const changes = await reevaluate(ws);
    assert.deepEqual(changes, [{ sealId: s.sealId!, from: 'sealed', to: 'tainted' }]);

    const after = await check({ workspaceId: ws, aliases: person('e3'), scope: 'refund.issue' }, STRENGTHS);
    assert.equal(after.bound, true, 'a tainted seal still binds — lifting on an unknown is a guess');
    assert.equal(after.reason, 'bound.tainted');
  });

  test('erasure destroys nothing the proof rests on', async () => {
    const ws = await freshWorkspace();
    await setup(ws, 'e4');
    const s = await seal({ workspaceId: ws, aliases: person('e4'), scope: 'refund',
      disposition: 'bind', rule: RULE, sealedBy: 'agent', claw: CLAW }, STRENGTHS);
    const { rows } = await getPool().query<{ subject_id: string }>(
      'SELECT subject_id FROM seals WHERE id = $1', [s.sealId]);

    await eraseSubject(ws, rows[0]!.subject_id);

    const { rows: facts } = await getPool().query(
      'SELECT value_sha256 FROM seal_facts WHERE seal_id = $1', [s.sealId]);
    assert.equal(facts.length, 2, 'the commitments survive; only the current values were deleted');
  });
});
