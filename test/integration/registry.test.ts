// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-08 · The rule registry.
 *
 * Three claims. That a committed version is its content, so it cannot be
 * edited and the same text commits once. That "which version governed on
 * date D" has exactly one answer, enforced by the database. And that a later
 * change in the law does not reach back and re-decide a historic
 * determination — which is the default the brief asks for, and it needs no
 * flag because the seal keeps its rule inline.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, reevaluate } from '../../src/domain/seal.js';
import { proof } from '../../src/domain/record.js';
import {
  declareRuleset, commitRule, closeRule, ruleHistory, validateCitation,
} from '../../src/domain/registry.js';
import { canonicalRule } from '../../src/domain/rule.js';
import { sha256Hex } from '../../src/lib/ids.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, countEvents, stateOf, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
// v1: up to two prior refunds. v2, a stricter later policy: none at all.
const V1 = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };
const V2 = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 1 },
] };
const H1 = sha256Hex(canonicalRule(V1 as never));
const H2 = sha256Hex(canonicalRule(V2 as never));
const CITE = '12 CFR 1026.13(e)';
const D = (s: string) => new Date(s);

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<ApiError> {
  let caught: ApiError | undefined;
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    caught = e;
    return true;
  }, why);
  return caught!;
}

async function twoVersions(A: Actors): Promise<void> {
  await declareRuleset(A.operator, { ruleset: 'refunds' });
  await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility', rule: V1,
    legalAuthority: CITE, effectiveFrom: D('2026-01-01'), effectiveTo: D('2026-06-01') });
  await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility', rule: V2,
    legalAuthority: CITE, effectiveFrom: D('2026-06-01') });
}

const under = (tag: string, asOf: string, extra: Record<string, unknown> = {}) => ({
  idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'refund',
  disposition: 'bind' as const, claw: CLAW,
  ruleRef: { ruleset: 'refunds', ruleId: 'refund.eligibility' }, asOf: D(asOf), ...extra,
});

async function facts(A: Actors, tag: string, refunds: number): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' },
    { fact: 'prior_refunds_90d', type: 'int', value: refunds, source: 'core_ledger' },
  ] }, STRENGTHS);
}

/* ── Committing ──────────────────────────────────────────────────────── */

describe('committing policy', () => {
  test('is an operator act, whatever scopes the agent key holds', async () => {
    const A = await actors();
    await refuses(() => declareRuleset(A.agent, { ruleset: 'refunds' }),
      'insufficient_authority', 'agent declaring a ruleset');
    await declareRuleset(A.operator, { ruleset: 'refunds' });
    await refuses(() => commitRule(A.agent, { ruleset: 'refunds', ruleId: 'r', rule: V1,
      legalAuthority: CITE, effectiveFrom: D('2026-01-01') }),
    'insufficient_authority', 'agent committing a rule');
  });

  test('the version is the content, so the same text commits exactly once', async () => {
    const A = await actors();
    await declareRuleset(A.operator, { ruleset: 'refunds' });
    const first = await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      rule: V1, legalAuthority: CITE, effectiveFrom: D('2026-01-01') });
    assert.equal(first.outcome, 'committed');
    assert.equal(first.version, H1, 'version is the canonical-form hash');
    // Same policy, children in the other order: same version. Canonical form
    // is what makes "same rule" a fact rather than a string comparison.
    const again = await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      rule: { all: [...V1.all].reverse() }, legalAuthority: CITE, effectiveFrom: D('2026-01-01') });
    assert.equal(again.outcome, 'already_committed');
    assert.equal(again.version, H1);
    assert.equal((await ruleHistory(A.operator, 'refunds', 'refund.eligibility')).length, 1);
  });

  test('a citation is required, and shape-checked', () => {
    for (const bad of ['', ' ', 'x', 'ab']) {
      assert.throws(() => validateCitation(bad), (e: unknown) =>
        e instanceof ApiError && e.code === 'invalid_citation', JSON.stringify(bad));
    }
    for (const ok of ['42 CFR 435.916(b)(1)', '7 CFR 273.2', '42 U.S.C. § 1396a(a)(8)',
      '42 USC 1396a', 'Cal. Welf. & Inst. Code § 14005.37', 'NY Soc. Serv. Law § 366',
      // Real rules cite two provisions, and annotate a section with the law that amended it.
      '7 CFR 273.9(a)(1); 7 CFR 273.10(e)(1)(i)(A)', '7 CFR 273.24 as amended by Pub. L. 119-21 §10102',
      '7 CFR 273.24 (pre-Pub. L. 119-21)']) {
      assert.equal(validateCitation(ok), ok);
    }
    assert.equal(validateCitation(' 7 CFR 273.2 ;7 CFR 273.14 '), '7 CFR 273.2; 7 CFR 273.14', 'normalised');
    for (const bad of ['7 CFR 273.2;', '; 7 CFR 273.2', '42', '7 CFR', 'x'.repeat(201)]) {
      assert.throws(() => validateCitation(bad), (e: unknown) =>
        e instanceof ApiError && e.code === 'invalid_citation', JSON.stringify(bad));
    }
  });

  test('two versions cannot be in force on the same day — the database refuses', async () => {
    const A = await actors();
    await declareRuleset(A.operator, { ruleset: 'refunds' });
    await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility', rule: V1,
      legalAuthority: CITE, effectiveFrom: D('2026-01-01') });
    const e = await refuses(() => commitRule(A.operator, { ruleset: 'refunds',
      ruleId: 'refund.eligibility', rule: V2, legalAuthority: CITE, effectiveFrom: D('2026-06-01') }),
    'rule_window_overlap', 'a second open-ended version');
    const inForce = (e.detail as { inForce: Array<{ version: string }> }).inForce;
    assert.deepEqual(inForce.map((r) => r.version), [H1], 'the refusal names the overlap');

    // Close the first, and the successor commits.
    const closed = await closeRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      version: H1, effectiveTo: D('2026-06-01') });
    assert.equal(closed.effectiveTo?.toISOString(), D('2026-06-01').toISOString());
    const v2 = await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      rule: V2, legalAuthority: CITE, effectiveFrom: D('2026-06-01') });
    assert.equal(v2.outcome, 'committed');
    assert.equal(v2.version, H2);

    // And the window cannot be re-opened over the successor.
    await refuses(() => closeRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      version: H1, effectiveTo: D('2026-09-01') }),
    'rule_window_overlap', 'extending v1 across v2');
    await refuses(() => closeRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      version: H1, effectiveTo: D('2025-12-01') }),
    'invalid_request', 'closing before it opened');
    await refuses(() => closeRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      version: '0'.repeat(64), effectiveTo: D('2026-03-01') }),
    'unknown_rule', 'closing a version that does not exist');
  });

  test('a ruleset belongs to one workspace', async () => {
    const A = await actors();
    const B = await actors();
    await declareRuleset(A.operator, { ruleset: 'refunds' });
    await refuses(() => commitRule(B.operator, { ruleset: 'refunds', ruleId: 'r', rule: V1,
      legalAuthority: CITE, effectiveFrom: D('2026-01-01') }),
    'unknown_ruleset', 'committing into another workspace\'s ruleset');
  });

  test('the history is every version, oldest first', async () => {
    const A = await actors();
    await twoVersions(A);
    const h = await ruleHistory(A.operator, 'refunds', 'refund.eligibility');
    assert.deepEqual(h.map((r) => r.version), [H1, H2]);
    assert.deepEqual(h.map((r) => r.legalAuthority), [CITE, CITE]);
  });
});

/* ── Selecting ───────────────────────────────────────────────────────── */

describe('a decision on date D uses the version in force at D', () => {
  test('before, during and after each window', async () => {
    const A = await actors();
    await twoVersions(A);
    await facts(A, 's1', 2);
    await facts(A, 's2', 2);
    await facts(A, 's3', 2);

    const inV1 = await seal(A.agent, under('s1', '2026-03-01'), STRENGTHS);
    assert.equal(inV1.outcome, 'sealed');
    assert.equal(inV1.ruleHash, H1);
    assert.equal(inV1.ruleRef?.version, H1);
    assert.equal(inV1.ruleRef?.legalAuthority, CITE);

    // Two prior refunds satisfy v1 and fail v2: the SAME facts, a different
    // date, a different answer — and the difference is the law, on the record.
    const inV2 = await seal(A.agent, under('s2', '2026-07-01'), STRENGTHS);
    assert.equal(inV2.outcome, 'not_applicable');
    assert.equal(inV2.ruleHash, H2);
    assert.equal(inV2.ruleRef?.version, H2);

    await refuses(() => seal(A.agent, under('s3', '2025-12-01'), STRENGTHS),
      'no_rule_in_force', 'a date before any version existed');
    await refuses(() => seal(A.agent, under('s3', '2026-03-01',
      { ruleRef: { ruleset: 'refunds', ruleId: 'no.such' } }), STRENGTHS),
    'unknown_rule', 'a rule id that was never committed');
    await refuses(() => seal(A.agent, under('s3', '2026-03-01',
      { ruleRef: { ruleset: 'nope', ruleId: 'refund.eligibility' } }), STRENGTHS),
    'unknown_rule', 'a ruleset that was never declared');
  });

  test('the record carries the date and the citation, and version equals rule_hash', async () => {
    const A = await actors();
    await twoVersions(A);
    await facts(A, 'p1', 2);
    const out = await seal(A.agent, under('p1', '2026-03-01'), STRENGTHS);
    const rec = await proof(A.operator, out.sealId!);
    assert.equal(rec.asOf?.toISOString(), D('2026-03-01').toISOString());
    assert.equal(rec.ruleRef?.version, rec.ruleHash, 'SPEC §8 step 3');
    assert.equal(rec.ruleRef?.ruleId, 'refund.eligibility');
    assert.equal(rec.ruleRef?.effectiveTo?.toISOString(), D('2026-06-01').toISOString());
    assert.deepEqual(rec.rule, V1, 'the rule is INLINE; the ref is a citation beside it');
  });

  test('an inline rule beside a reference must be the same rule', async () => {
    const A = await actors();
    await twoVersions(A);
    await facts(A, 'm1', 2);
    await refuses(() => seal(A.agent, under('m1', '2026-03-01', { rule: V2 }), STRENGTHS),
      'rule_ref_mismatch', 'inline v2 text with a reference that resolves to v1');
    const ok = await seal(A.agent, under('m1', '2026-03-01', { rule: V1 }), STRENGTHS);
    assert.equal(ok.outcome, 'sealed');
    assert.equal(ok.ruleRef?.version, H1);
  });

  test('a rule declared for a scope refuses a determination outside it', async () => {
    const A = await actors();
    await declareRuleset(A.operator, { ruleset: 'refunds' });
    await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility', rule: V1,
      legalAuthority: CITE, effectiveFrom: D('2026-01-01'), scope: 'refund' });
    await facts(A, 'sc1', 2);
    await refuses(() => seal(A.agent, under('sc1', '2026-03-01', { scope: 'payout' }), STRENGTHS),
      'rule_scope_mismatch', 'sealing in payout under a refund rule');
    const inside = await seal(A.agent, under('sc1', '2026-03-01', { scope: 'refund.partial' }), STRENGTHS);
    assert.equal(inside.outcome, 'sealed', 'a narrower scope is inside the declared one');
  });

  test('a replay returns the version the original was made under', async () => {
    const A = await actors();
    await twoVersions(A);
    await facts(A, 'rp1', 2);
    const first = await seal(A.agent, under('rp1', '2026-03-01'), STRENGTHS);
    const again = await seal(A.agent, under('rp1', '2026-03-01'), STRENGTHS);
    assert.equal(again.outcome, 'replayed');
    assert.deepEqual(again.ruleRef, first.ruleRef);
  });

  test('a seal with neither an inline rule nor a reference is refused', async () => {
    const A = await actors();
    await facts(A, 'n1', 2);
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-n1', aliases: person('n1'),
      scope: 'refund', disposition: 'bind', claw: CLAW }, STRENGTHS),
    'invalid_request', 'no rule at all');
  });
});

/* ── History does not move ───────────────────────────────────────────── */

describe('a later change in the law', () => {
  test('does not alter a historic determination — re-evaluation runs the rule as sealed', async () => {
    const A = await actors();
    await declareRuleset(A.operator, { ruleset: 'refunds' });
    await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility', rule: V1,
      legalAuthority: CITE, effectiveFrom: D('2026-01-01') });
    await facts(A, 'h1', 2);
    const out = await seal(A.agent, under('h1', '2026-03-01'), STRENGTHS);
    assert.equal(out.outcome, 'sealed');

    // The law tightens. Under v2 these same facts do not hold.
    await closeRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility',
      version: H1, effectiveTo: D('2026-04-01') });
    await commitRule(A.operator, { ruleset: 'refunds', ruleId: 'refund.eligibility', rule: V2,
      legalAuthority: CITE, effectiveFrom: D('2026-04-01') });

    // Re-attest the same values so the seal is due, then sweep.
    await facts(A, 'h1', 2);
    await reevaluate(A.ws);
    assert.equal(await stateOf(out.sealId!), 'sealed');
    assert.equal(await countEvents(out.sealId!, 'lapsed'), 0,
      'the determination was made under v1 and is still governed by v1');

    // The snapshot records the window AS IT WAS: open-ended when sealed.
    const rec = await proof(A.operator, out.sealId!);
    assert.equal(rec.ruleRef?.effectiveTo, null);

    // And a NEW determination about a date after the change uses v2.
    await facts(A, 'h2', 2);
    const later = await seal(A.agent, under('h2', '2026-05-01'), STRENGTHS);
    assert.equal(later.outcome, 'not_applicable');
    assert.equal(later.ruleRef?.version, H2);
  });

  test('a determination with no reference is what every determination was', async () => {
    const A = await actors();
    await facts(A, 'i1', 2);
    const out = await seal(A.agent, { idempotencyKey: 'idem-i1', aliases: person('i1'),
      scope: 'refund', disposition: 'bind', rule: V1, claw: CLAW }, STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    assert.equal(out.ruleRef, null);
    const rec = await proof(A.operator, out.sealId!);
    assert.equal(rec.ruleRef, null);
    assert.equal(rec.asOf, null);
  });
});
