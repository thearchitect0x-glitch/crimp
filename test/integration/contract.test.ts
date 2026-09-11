// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The four contract-shaping properties, settled before anybody integrates.
 *
 * Three of these were defects — a determination could be created twice, no seal
 * recorded which grammar evaluated it, and a determination bound forever. The
 * fourth is the constraint that keeps cohorts a measurement instead of a
 * weapon. All four change the wire contract, which is why they are here rather
 * than on the roadmap.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest, eraseSubject } from '../../src/domain/attest.js';
import { seal, lookup, exercise, reevaluate } from '../../src/domain/seal.js';
import { declareCohort, placeInCohort } from '../../src/domain/cohort.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, countEvents, expireSeal, stateOf, STRENGTHS,
  type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { all: [
  { fact: 'carrier.delivered', op: 'eq', value: false },
  { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
] };
const OTHER_RULE = { fact: 'prior_refunds_90d', op: 'lt', value: 9 };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    return true;
  }, why);
}

async function setup(A: Actors, tag: string, refunds = 1): Promise<void> {
  await attest(A.agent, { aliases: person(tag),
    facts: [
      { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' },
      { fact: 'prior_refunds_90d', type: 'int', value: refunds, source: 'core_ledger' },
    ],
  }, STRENGTHS);
}

/* ── 1 · A determination cannot be created twice ─────────────────────── */

describe('idempotency', () => {
  test('a retry replays the original determination rather than creating a second', async () => {
    const A = await actors();
    await setup(A, 'k1');
    const args = { idempotencyKey: 'retry-me', aliases: person('k1'), scope: 'refund',
      disposition: 'bind' as const, rule: RULE, claw: CLAW };

    const first = await seal(A.agent, args, STRENGTHS);
    const again = await seal(A.agent, args, STRENGTHS);

    assert.equal(first.outcome, 'sealed');
    assert.equal(again.outcome, 'replayed', 'a retry is not a new determination');
    assert.equal(again.sealId, first.sealId, 'and it points at the original');

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM seals WHERE workspace_id = $1', [A.ws]);
    assert.equal(Number(rows[0]!.n), 1, 'one row, not two');
    assert.equal(await countEvents(first.sealId!, 'sealed'), 1, 'and one event, not two');
  });

  test('a permit retried does not grant a second use — the loss this prevents', async () => {
    const A = await actors();
    await setup(A, 'k2');
    const args = { idempotencyKey: 'one-grant', aliases: person('k2'), scope: 'refund',
      disposition: 'permit' as const, rule: RULE, claw: CLAW, maxUses: 1 };
    await seal(A.agent, args, STRENGTHS);
    await seal(A.agent, args, STRENGTHS);

    // One permit exists, not two. Looking does not spend it — that separation
    // is what makes this checkable at all.
    const found = await lookup(A.agent, { aliases: person('k2'), scope: 'refund' }, STRENGTHS);
    assert.equal(found.determinations.length, 1, 'one grant, not two');

    const id = found.determinations[0]!.sealId;
    assert.equal((await exercise(A.agent, { sealId: id })).exercised, true);
    assert.equal((await exercise(A.agent, { sealId: id })).exercised, false,
      'a timed-out POST that was retried must not become two grants');
  });

  test('the same key for a different rule is refused, not silently replayed', async () => {
    const A = await actors();
    await setup(A, 'k3');
    await seal(A.agent, { idempotencyKey: 'shared', aliases: person('k3'), scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    await refuses(() => seal(A.agent, { idempotencyKey: 'shared', aliases: person('k3'),
      scope: 'refund', disposition: 'bind', rule: OTHER_RULE, claw: CLAW }, STRENGTHS),
    'idempotency_key_reuse', 'reuse would make the first determination unfindable');
  });

  test('the key is workspace-scoped, so two tenants cannot collide', async () => {
    const [A, B] = [await actors(), await actors()];
    await setup(A, 'k4');
    await setup(B, 'k4');
    const args = { idempotencyKey: 'same-string', scope: 'refund',
      disposition: 'bind' as const, rule: RULE, claw: CLAW };
    const a = await seal(A.agent, { ...args, aliases: person('k4') }, STRENGTHS);
    const b = await seal(B.agent, { ...args, aliases: person('k4') }, STRENGTHS);
    assert.equal(a.outcome, 'sealed');
    assert.equal(b.outcome, 'sealed', "one tenant's key must not replay into another's");
    assert.notEqual(a.sealId, b.sealId);
  });

  test('a malformed key is refused before any work happens', async () => {
    const A = await actors();
    await setup(A, 'k5');
    for (const bad of ['', 'has spaces', 'x'.repeat(129)]) {
      await refuses(() => seal(A.agent, { idempotencyKey: bad, aliases: person('k5'),
        scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS),
      'invalid_request', `idempotency key ${JSON.stringify(bad)} is not usable`);
    }
  });
});

/* ── 2 · Every seal records which grammar evaluated it ───────────────── */

describe('grammar version', () => {
  test('a seal records the grammar it was evaluated under', async () => {
    const A = await actors();
    await setup(A, 'g1');
    const s = await seal(A.agent, { idempotencyKey: 'idem-g1', aliases: person('g1'),
      scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    const { rows } = await getPool().query<{ grammar_version: string }>(
      'SELECT grammar_version FROM seals WHERE id = $1', [s.sealId]);
    assert.equal(rows[0]?.grammar_version, '1');
  });

  test('a grammar this build cannot reproduce taints, and never re-decides', async () => {
    const A = await actors();
    await setup(A, 'g2');
    const s = await seal(A.agent, { idempotencyKey: 'idem-g2', aliases: person('g2'),
      scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    // A determination sealed by a future build, being re-evaluated by this one.
    await getPool().query("UPDATE seals SET grammar_version = '99' WHERE id = $1", [s.sealId]);
    // Make the facts disagree with the rule. A version-blind evaluator would
    // now lapse it — declaring the institution wrong under semantics it cannot
    // reproduce. That is the failure this guards.
    await attest(A.agent, { aliases: person('g2'),
      facts: [{ fact: 'prior_refunds_90d', type: 'int', value: 7, source: 'core_ledger' }] },
    STRENGTHS);

    // The write re-executed it under THIS build's evaluator, which cannot
    // reproduce version 99: lost ground, not a disproof, at the write itself.
    assert.equal(await stateOf(s.sealId!), 'tainted');
    assert.equal(await countEvents(s.sealId!, 'lapsed'), 0, 'never re-decided');
    const { changes } = await reevaluate(A.ws);
    assert.equal(changes.length, 0, 'nothing left for the pass');
  });
});

/* ── 3 · A determination can stop standing ───────────────────────────── */

describe('expiry', () => {
  test('an expired determination stops binding without waiting for a sweep', async () => {
    const A = await actors();
    await setup(A, 'x1');
    const s = await seal(A.agent, { idempotencyKey: 'idem-x1', aliases: person('x1'),
      scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW,
      expiresAt: new Date(Date.now() + 3_600_000) }, STRENGTHS);

    const before = await lookup(A.agent, { aliases: person('x1'), scope: 'refund' }, STRENGTHS);
    assert.equal(before.determinations.length, 1);

    await expireSeal(s.sealId!);
    const after = await lookup(A.agent, { aliases: person('x1'), scope: 'refund' }, STRENGTHS);
    assert.equal(after.determinations.length, 0,
      'the row still says sealed; the clock decides');
    assert.equal(await stateOf(s.sealId!), 'sealed', 'and no sweep has run yet');
  });

  test('expired is its own state, because collapsing it into lapsed would corrupt the quadrant',
    async () => {
      const A = await actors();
      await setup(A, 'x2');
      const s = await seal(A.agent, { idempotencyKey: 'idem-x2', aliases: person('x2'),
        scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW,
        expiresAt: new Date(Date.now() + 3_600_000) }, STRENGTHS);
      await expireSeal(s.sealId!);

      const { changes } = await reevaluate(A.ws);
      assert.equal(changes[0]?.to, 'expired',
        'running out is not the institution having been wrong');
      assert.equal(await countEvents(s.sealId!, 'expired'), 1);
    });

  test('expiry wins over a rule that no longer holds, so a lapse is never invented late',
    async () => {
      const A = await actors();
      await setup(A, 'x3');
      const s = await seal(A.agent, { idempotencyKey: 'idem-x3', aliases: person('x3'),
        scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW,
        expiresAt: new Date(Date.now() + 3_600_000) }, STRENGTHS);
      await expireSeal(s.sealId!);
      await attest(A.agent, { aliases: person('x3'),
        facts: [{ fact: 'prior_refunds_90d', type: 'int', value: 7, source: 'core_ledger' }] },
      STRENGTHS);

      await reevaluate(A.ws);
      assert.equal(await stateOf(s.sealId!), 'expired',
        'the determination was over before the facts moved');
    });

  test('a determination cannot be born expired', async () => {
    const A = await actors();
    await setup(A, 'x5');
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-x5', aliases: person('x5'),
      scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW,
      expiresAt: new Date(Date.now() - 60_000) }, STRENGTHS),
    'expiry_in_the_past',
    'it would bind nothing and report itself sealed — the silent failure');
  });

  test('no expiry means it stands until something ends it', async () => {
    const A = await actors();
    await setup(A, 'x4');
    const s = await seal(A.agent, { idempotencyKey: 'idem-x4', aliases: person('x4'),
      scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    await reevaluate(A.ws);
    assert.equal(await stateOf(s.sealId!), 'sealed');
  });
});

/* ── 4 · Cohorts measure the system, never a person ──────────────────── */

describe('cohorts', () => {
  test('a declared cohort cannot then be attested as a fact', async () => {
    const A = await actors();
    await declareCohort(A.custodian, { cohort: 'region', description: 'service region' });
    await refuses(() => attest(A.agent, { aliases: person('c1'),
      facts: [{ fact: 'region', type: 'str', value: 'north', source: 'core_ledger' }] }, STRENGTHS),
    'fact_is_a_cohort', 'a cohort that can be attested can appear in a rule');
  });

  test('and a name already attested as a fact cannot be declared a cohort', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('c2'),
      facts: [{ fact: 'tenure_days', type: 'int', value: 400, source: 'core_ledger' }] }, STRENGTHS);
    await refuses(() => declareCohort(A.custodian, { cohort: 'tenure_days' }),
      'cohort_is_a_fact', 'the two namespaces are disjoint in both directions');
  });

  test('the collision refusal writes nothing — the whole batch is refused', async () => {
    const A = await actors();
    await declareCohort(A.custodian, { cohort: 'region' });
    await refuses(() => attest(A.agent, { aliases: person('c3'), facts: [
      { fact: 'prior_refunds_90d', type: 'int', value: 1, source: 'core_ledger' },
      { fact: 'region', type: 'str', value: 'north', source: 'core_ledger' },
    ] }, STRENGTHS), 'fact_is_a_cohort', 'refused as a unit');
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM attestations WHERE workspace_id = $1', [A.ws]);
    assert.equal(Number(rows[0]!.n), 0, 'no partial write slipped through');
  });

  test('an agent key cannot place anybody in a cohort', async () => {
    const A = await actors();
    await declareCohort(A.custodian, { cohort: 'region' });
    await setup(A, 'c4');
    // The agent principal in `actors()` holds every scope, so narrow to what a
    // real agent gets: cohorts:write is deliberately not in AGENT_SCOPES.
    const narrowed = { ...A.agent, scopes: new Set(['attestations:write', 'seals:write',
      'bindings:check']) };
    await refuses(() => placeInCohort(narrowed, { aliases: person('c4'), cohort: 'region',
      band: 'north' }, STRENGTHS),
    'forbidden', 'an agent that can shape the cohorts can shape the measurement of itself');
  });

  test('the band is stored blinded, never in the clear', async () => {
    const A = await actors();
    await declareCohort(A.custodian, { cohort: 'region' });
    await setup(A, 'c5');
    await placeInCohort(A.custodian, { aliases: person('c5'), cohort: 'region', band: 'north' },
      STRENGTHS);
    const { rows } = await getPool().query<{ band: string }>(
      'SELECT band FROM subject_cohorts WHERE workspace_id = $1', [A.ws]);
    assert.match(rows[0]!.band, /^[0-9a-f]{32}$/);
    assert.notEqual(rows[0]!.band, 'north');
  });

  test('the same band in two workspaces is two unrelated values', async () => {
    const bands: string[] = [];
    for (const A of [await actors(), await actors()]) {
      await declareCohort(A.custodian, { cohort: 'region' });
      await setup(A, 'c6');
      await placeInCohort(A.custodian, { aliases: person('c6'), cohort: 'region', band: 'north' },
        STRENGTHS);
      const { rows } = await getPool().query<{ band: string }>(
        'SELECT band FROM subject_cohorts WHERE workspace_id = $1', [A.ws]);
      bands.push(rows[0]!.band);
    }
    assert.notEqual(bands[0], bands[1], 'there is no cross-tenant correlation to leak');
  });

  test('placement will not invent a subject', async () => {
    const A = await actors();
    await declareCohort(A.custodian, { cohort: 'region' });
    await refuses(() => placeInCohort(A.custodian, { aliases: person('c7'), cohort: 'region',
      band: 'north' }, STRENGTHS),
    'unknown_subject', 'this table must not be how people enter Crimp');
  });

  test('an undeclared cohort is refused', async () => {
    const A = await actors();
    await setup(A, 'c8');
    await refuses(() => placeInCohort(A.custodian, { aliases: person('c8'), cohort: 'undeclared',
      band: 'north' }, STRENGTHS), 'unknown_cohort', 'declare it first');
  });

  test('erasure takes the cohort membership with it', async () => {
    const A = await actors();
    await declareCohort(A.custodian, { cohort: 'region' });
    await setup(A, 'c9');
    const { subjectId } = await placeInCohort(A.custodian, { aliases: person('c9'),
      cohort: 'region', band: 'north' }, STRENGTHS);
    await eraseSubject(A.ws, subjectId);
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM subject_cohorts WHERE subject_id = $1', [subjectId]);
    assert.equal(Number(rows[0]!.n), 0,
      'a row with no read path is exactly the row an erasure leaves behind');
  });
});
