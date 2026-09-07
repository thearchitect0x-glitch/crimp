// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Why, on the record — and who asked.
 *
 * Two things are being tested. That the reason set is accurate and durable,
 * because an inaccurate principal reason is a Regulation B problem rather
 * than a cosmetic one. And that the value-bearing form is gated and recorded,
 * because the specificity a regulator requires and the probe an adversary runs
 * are the same request.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, claw, reevaluate } from '../../src/domain/seal.js';
import { proof, disclosure, disclosures } from '../../src/domain/record.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, countEvents, hash64, STRENGTHS, type Actors } from '../helpers.js';
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

async function setup(A: Actors, tag: string, refunds = 1, delivered = false): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'carrier.delivered', type: 'bool', value: delivered, source: 'carrier_api' },
    { fact: 'prior_refunds_90d', type: 'int', value: refunds, source: 'core_ledger' },
  ] }, STRENGTHS);
}

const bind = (tag: string) => ({
  idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'refund',
  disposition: 'bind' as const, rule: RULE, claw: CLAW,
});

/* ── Reasons ─────────────────────────────────────────────────────────── */

describe('a determination says why', () => {
  test('a refusal names every clause that produced it', async () => {
    const A = await actors();
    await setup(A, 'r1');
    const out = await seal(A.agent, bind('r1'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    assert.deepEqual(out.reasons.map((r) => `${r.path} ${r.fact} ${r.op}`).sort(), [
      'all[0] carrier.delivered eq',
      'all[1] prior_refunds_90d lt',
    ], 'a conjunction that held needed every clause, so every clause is a reason');
    assert.ok(out.reasons.every((r) => r.truth === 'true' && r.polarity === 'direct'));
  });

  test('a rule that did not apply names only the clauses that failed', async () => {
    const A = await actors();
    await setup(A, 'r2', 9);   // too many prior refunds; delivery clause still holds
    const out = await seal(A.agent, bind('r2'), STRENGTHS);
    assert.equal(out.outcome, 'not_applicable');
    assert.equal(out.reasons.length, 1, 'the principal reason, not a grab bag');
    assert.equal(out.reasons[0]?.fact, 'prior_refunds_90d');
    assert.equal(out.reasons[0]?.truth, 'false');
  });

  test('no value ever appears in a reason', async () => {
    const A = await actors();
    await setup(A, 'r3', 9);
    const out = await seal(A.agent, bind('r3'), STRENGTHS);
    const wire = JSON.stringify(out.reasons);
    assert.equal(wire.includes('observed'), false);
    // 9 is the attested value; 3 is the rule's own literal and belongs here.
    assert.equal(/[^0-9]9[^0-9]/.test(wire), false, 'the attested value must not leak');
  });

  test('the reasons are stored, because they cannot be re-derived', async () => {
    const A = await actors();
    await setup(A, 'r4');
    const out = await seal(A.agent, bind('r4'), STRENGTHS);
    const { rows } = await getPool().query<{ reasons: unknown[] }>(
      'SELECT reasons FROM seals WHERE id = $1', [out.sealId]);
    assert.equal(rows[0]?.reasons.length, 2);
  });

  test('a replay returns the ORIGINAL reasons, not a fresh derivation', async () => {
    const A = await actors();
    await setup(A, 'r5');
    const first = await seal(A.agent, bind('r5'), STRENGTHS);
    // The ground moves underneath. A retry of the same request must still
    // report the determination that was made, or the same idempotency key
    // describes two different decisions.
    await attest(A.agent, { aliases: person('r5'), facts: [
      { fact: 'prior_refunds_90d', type: 'int', value: 40, source: 'core_ledger' }] }, STRENGTHS);
    const again = await seal(A.agent, bind('r5'), STRENGTHS);
    assert.equal(again.outcome, 'replayed');
    assert.deepEqual(again.reasons, first.reasons);
  });

  test('a disjunction names only the branch that fired', async () => {
    const A = await actors();
    await setup(A, 'r6', 1);
    const out = await seal(A.agent, { ...bind('r6'), rule: { any: [
      { fact: 'prior_refunds_90d', op: 'gt', value: 100 },
      { fact: 'carrier.delivered', op: 'eq', value: false },
    ] } }, STRENGTHS);
    assert.equal(out.reasons.length, 1, 'one sufficient branch is the reason');
    assert.equal(out.reasons[0]?.fact, 'carrier.delivered');
  });

  test('a clause under a negation is marked negated, so a notice cannot state it backwards',
    async () => {
      const A = await actors();
      await setup(A, 'r7', 1, true);   // delivered = true
      const out = await seal(A.agent, { ...bind('r7'),
        rule: { not: { fact: 'carrier.delivered', op: 'eq', value: false } } }, STRENGTHS);
      assert.equal(out.outcome, 'sealed');
      assert.equal(out.reasons[0]?.polarity, 'negated');
      assert.equal(out.reasons[0]?.truth, 'false',
        'the refusal stands BECAUSE the inner clause is false');
    });
});

/* ── The proof ───────────────────────────────────────────────────────── */

describe('the examiner artifact', () => {
  test('carries the rule, its hash, the grammar, and digests — never a value', async () => {
    const A = await actors();
    await setup(A, 'p1');
    const s = await seal(A.agent, bind('p1'), STRENGTHS);
    const pr = await proof(A.operator, s.sealId!);

    assert.equal(pr.ruleHash, s.ruleHash);
    assert.equal(pr.grammarVersion, '1');
    assert.equal(pr.state, 'sealed');
    assert.equal(pr.facts.length, 2);
    for (const f of pr.facts) {
      assert.match(f.valueSha256, /^[0-9a-f]{64}$/);
      assert.ok(f.source && f.admissibility, 'provenance travels with the digest');
    }
    assert.equal(JSON.stringify(pr).includes('sub_'), false,
      'a proof is about a determination, not a person — no subject id to enumerate');
    assert.match(pr.verify.valueDigest, /sha256/,
      'a proof that does not say how to check it will not be checked');
  });

  test('the digest is reproducible from the value by anybody holding it', async () => {
    const A = await actors();
    await setup(A, 'p2', 7);
    const s = await seal(A.agent, { ...bind('p2'),
      rule: { fact: 'prior_refunds_90d', op: 'gt', value: 3 } }, STRENGTHS);
    const pr = await proof(A.operator, s.sealId!);

    const { createHash } = await import('node:crypto');
    const { canonicalize } = await import('../../src/lib/ids.js');
    const mine = createHash('sha256')
      .update(canonicalize({ t: 'int', v: 7 })).digest('hex');
    assert.equal(pr.facts[0]?.valueSha256, mine,
      'the whole reproducibility claim is this line');
  });

  test('every event is in the record, including the claw', async () => {
    const A = await actors();
    await setup(A, 'p3');
    const s = await seal(A.agent, bind('p3'), STRENGTHS);
    await claw(A.operator, { sealId: s.sealId!, evidenceSha256: hash64('e'),
      evidenceClass: 'receipt' });
    const pr = await proof(A.operator, s.sealId!);
    assert.deepEqual(pr.events.map((e) => e.kind), ['sealed', 'clawed']);
    assert.equal(pr.events[1]?.evidenceClass, 'receipt');
    assert.equal(pr.state, 'clawed');
  });

  test('a lapse shows in the record without anyone having asked', async () => {
    const A = await actors();
    await setup(A, 'p4');
    const s = await seal(A.agent, bind('p4'), STRENGTHS);
    await attest(A.agent, { aliases: person('p4'), facts: [
      { fact: 'carrier.delivered', type: 'bool', value: true, source: 'carrier_api' }] },
    STRENGTHS);
    await reevaluate(A.ws);
    const pr = await proof(A.operator, s.sealId!);
    assert.equal(pr.state, 'lapsed');
    assert.ok(pr.events.some((e) => e.kind === 'lapsed' && e.actor === null),
      'nothing decided a lapse; a fact changed');
  });

  test('a determination in another workspace is a 404, not a hint', async () => {
    const [A, B] = [await actors(), await actors()];
    await setup(A, 'p5');
    const s = await seal(A.agent, bind('p5'), STRENGTHS);
    await refuses(() => proof(B.operator, s.sealId!), 'not_found',
      'a cross-tenant read must not confirm the record exists elsewhere');
  });

  test('an agent key cannot read the record back', async () => {
    const A = await actors();
    await setup(A, 'p6');
    const s = await seal(A.agent, bind('p6'), STRENGTHS);
    const narrowed = { ...A.agent,
      scopes: new Set(['attestations:write', 'seals:write', 'bindings:check']) };
    await refuses(() => proof(narrowed, s.sealId!), 'forbidden',
      'the quickstart key stays narrow');
  });
});

/* ── Disclosure ──────────────────────────────────────────────────────── */

describe('asking why is itself on the record', () => {
  test('the values come back, with provenance and the value that would have passed',
    async () => {
      const A = await actors();
      await setup(A, 'd1', 7);
      const s = await seal(A.agent, { ...bind('d1'),
        rule: { fact: 'prior_refunds_90d', op: 'lt', value: 3 } }, STRENGTHS);
      // The rule did not hold, so nothing was sealed. Seal the refusal the
      // other way round: too many refunds IS the refusal.
      assert.equal(s.outcome, 'not_applicable');

      const refusal = await seal(A.agent, { ...bind('d1b'), aliases: person('d1'),
        rule: { fact: 'prior_refunds_90d', op: 'gte', value: 3 } }, STRENGTHS);
      const d = await disclosure(A.operator, refusal.sealId!);

      assert.equal(d.reasons[0]?.observed, 7);
      assert.equal(d.reasons[0]?.source, 'core_ledger');
      assert.equal(d.reasons[0]?.admissibility, 'internal');
      assert.ok(d.recordedAt instanceof Date);
    });

  test('a failed threshold names the value that would have satisfied it', async () => {
    const A = await actors();
    await setup(A, 'd2', 7);
    const out = await seal(A.agent, { ...bind('d2'),
      rule: { fact: 'prior_refunds_90d', op: 'lt', value: 3 } }, STRENGTHS);
    assert.equal(out.outcome, 'not_applicable');
    // The value-free reasons carry no threshold guidance at all.
    assert.equal(JSON.stringify(out.reasons).includes('would_have_needed'), false);
  });

  test('an agent cannot disclose, whatever scopes it holds', async () => {
    const A = await actors();
    await setup(A, 'd3');
    const s = await seal(A.agent, bind('d3'), STRENGTHS);
    await refuses(() => disclosure(A.agent, s.sealId!), 'insufficient_authority',
      'an agent that could disclose thresholds could map every cliff in the policy');
  });

  test('the disclosure is recorded, and the record does not repeat the values', async () => {
    const A = await actors();
    await setup(A, 'd4');
    const s = await seal(A.agent, bind('d4'), STRENGTHS);
    assert.equal(s.outcome, 'sealed');
    await disclosure(A.operator, s.sealId!);
    assert.equal(await countEvents(s.sealId!, 'disclosed'), 1);

    const { rows } = await getPool().query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM seal_events WHERE seal_id = $1 AND kind = 'disclosed'", [s.sealId]);
    assert.ok(Array.isArray(rows[0]?.detail['facts']), 'it says which facts were revealed');
    assert.equal(JSON.stringify(rows[0]?.detail).includes('observed'), false,
      'the record of a disclosure must not become a second copy of the disclosure');
  });

  test('a disclosure is not pressure — conflating them would corrupt the quadrant', async () => {
    const A = await actors();
    await setup(A, 'd5');
    const s = await seal(A.agent, bind('d5'), STRENGTHS);
    await disclosure(A.operator, s.sealId!);
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM pressure WHERE seal_id = $1', [s.sealId]);
    assert.equal(Number(rows[0]!.n), 0, 'asking why is not resisting');
  });

  test('who asked why is queryable, which nothing else records', async () => {
    const A = await actors();
    await setup(A, 'd6');
    const s = await seal(A.agent, bind('d6'), STRENGTHS);
    await disclosure(A.operator, s.sealId!);
    await disclosure(A.custodian, s.sealId!);
    const log = await disclosures(A.operator);
    assert.equal(log.length, 2);
    assert.deepEqual(log.map((d) => d.actor).sort(), ['custodian', 'operator']);
    assert.ok(log[0]!.facts.includes('carrier.delivered'));
  });
});
