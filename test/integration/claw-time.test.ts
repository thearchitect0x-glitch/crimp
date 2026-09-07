// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The time axis of a claw rule, which the authority ladder never bounded.
 *
 * `validateClawRule` has always bounded WHO may reverse a determination, with
 * the reasoning written out: "an agent that can put determinations beyond an
 * operator's reach is a denial-of-service weapon pointed at its own
 * workspace." That was enforced on one axis.
 *
 * Cooling-off had a single ceiling for every authority, and a determination's
 * duration had none at all — absent `expires_at` meant forever. So an agent
 * holding nothing but `seals:write` could author a refusal that never expires
 * and that nobody, including a custodian, could lift for three months. The
 * identical weapon, along the axis nobody checked.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { TIME_BOUNDS, MAX_COOLING_OFF_SECONDS } from '../../src/domain/authority.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, STRENGTHS, type Actors } from '../helpers.js';
import type { Authority, ClawRule } from '../../src/domain/authority.js';

const RULE = { fact: 'carrier.delivered', op: 'eq', value: false };
const DAY = 24 * 3600;

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function ground(A: Actors, tag: string): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] }, STRENGTHS);
}

/**
 * A claw rule one rung above the sealer.
 *
 * `custodian` is absent on purpose and the reason is worth stating: the claw
 * authority must STRICTLY exceed the sealer, and nothing exceeds the top of a
 * total order — so a custodian cannot seal anything at all. That is not an
 * oversight, it is the no-self-reversal rule reaching its logical end. The
 * highest authority governs the system; it does not decide cases, precisely
 * because its decisions would be irreversible. Asserted below rather than left
 * as folklore.
 */
const SEALERS: Authority[] = ['agent', 'operator', 'principal'];
const clawFor = (sealedBy: Authority, coolingOffSeconds: number): ClawRule => ({
  authority: sealedBy === 'agent' ? 'operator' : 'custodian',
  evidenceFloor: 'internal', coolingOffSeconds,
});

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    return true;
  }, why);
}

describe('cooling-off is bounded by the authority imposing it', () => {
  test('an agent cannot freeze a determination for ninety days', async () => {
    const A = await actors();
    await ground(A, 't1');
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-t1', aliases: person('t1'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: clawFor('agent', MAX_COOLING_OFF_SECONDS) }, STRENGTHS),
    'invalid_claw_rule',
    'the wait falls on the person still refused; an automated process may not impose the longest one');
  });

  test('each rung may impose exactly its own ceiling and not a second more', async () => {
    for (const level of SEALERS) {
      const A = await actors();
      const bound = TIME_BOUNDS[level].coolingOffSeconds;
      await ground(A, `t2-${level}`);

      const ok = await seal(A[level], { idempotencyKey: `idem-ok-${level}`,
        aliases: person(`t2-${level}`), scope: 'refund', disposition: 'bind', rule: RULE,
        claw: clawFor(level, bound) }, STRENGTHS);
      assert.equal(ok.outcome, 'sealed', `${level} may impose its own ceiling`);

      await ground(A, `t2b-${level}`);
      await refuses(() => seal(A[level], { idempotencyKey: `idem-no-${level}`,
        aliases: person(`t2b-${level}`), scope: 'refund', disposition: 'bind', rule: RULE,
        claw: clawFor(level, bound + 1) }, STRENGTHS),
      'invalid_claw_rule', `${level} may not exceed it`);
    }
  });

  test('the ladder is monotone — no rung may impose less than the one below', () => {
    const order: Authority[] = ['agent', 'operator', 'principal', 'custodian'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        TIME_BOUNDS[order[i]!].coolingOffSeconds >= TIME_BOUNDS[order[i - 1]!].coolingOffSeconds,
        'a higher authority that could impose LESS delay would invert the whole argument');
    }
    assert.equal(TIME_BOUNDS.custodian.coolingOffSeconds, MAX_COOLING_OFF_SECONDS);
    assert.equal(TIME_BOUNDS.custodian.maxDurationSeconds, null);
  });
});

describe('the closer: a determination shuts itself', () => {
  test('an agent cannot author a permanent refusal', async () => {
    const A = await actors();
    await ground(A, 'c1');
    const s = await seal(A.agent, { idempotencyKey: 'idem-c1', aliases: person('c1'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: clawFor('agent', 0) }, STRENGTHS);   // no expiry asked for

    assert.ok(s.expiresAt instanceof Date, 'absent expiry is capped, not accepted as forever');
    const days = (s.expiresAt.getTime() - Date.now()) / (DAY * 1000);
    assert.ok(days > 29 && days <= 30, `expected ~30 days, got ${days}`);

    const { rows } = await getPool().query<{ expires_at: Date | null }>(
      'SELECT expires_at FROM seals WHERE id = $1', [s.sealId]);
    assert.ok(rows[0]!.expires_at, 'and it is what was stored, not only what was reported');
  });

  test('an over-long expiry is capped rather than refused, and the caller is told', async () => {
    const A = await actors();
    await ground(A, 'c2');
    const s = await seal(A.operator, { idempotencyKey: 'idem-c2', aliases: person('c2'),
      scope: 'refund', disposition: 'bind', rule: RULE, claw: clawFor('operator', 0),
      expiresAt: new Date(Date.now() + 10 * 365 * DAY * 1000) }, STRENGTHS);
    const days = (s.expiresAt!.getTime() - Date.now()) / (DAY * 1000);
    assert.ok(days > 364 && days <= 365, `operator ceiling is a year, got ${days}`);
  });

  test('an expiry inside the ceiling is left exactly alone', async () => {
    const A = await actors();
    await ground(A, 'c3');
    const asked = new Date(Date.now() + 7 * DAY * 1000);
    const s = await seal(A.agent, { idempotencyKey: 'idem-c3', aliases: person('c3'),
      scope: 'refund', disposition: 'bind', rule: RULE, claw: clawFor('agent', 0),
      expiresAt: asked }, STRENGTHS);
    assert.equal(s.expiresAt?.getTime(), asked.getTime(),
      'capping must not become deciding');
  });

  test('the top of the ladder cannot seal at all, whichever reverser it names', async () => {
    const A = await actors();
    await ground(A, 'c4');
    // Every possible claw authority, including the two below it. All refused:
    // the reverser must STRICTLY exceed the sealer, and nothing exceeds the top
    // of a total order. So `TIME_BOUNDS.custodian` is unreachable through
    // `seal()` — stated here so it is a known property rather than dead
    // configuration nobody noticed.
    for (const authority of ['agent', 'operator', 'principal', 'custodian'] as Authority[]) {
      await refuses(() => seal(A.custodian, { idempotencyKey: `idem-c4-${authority}`,
        aliases: person('c4'), scope: 'refund', disposition: 'bind', rule: RULE,
        claw: { authority, evidenceFloor: 'internal', coolingOffSeconds: 0 } }, STRENGTHS),
      'invalid_claw_rule',
      'the highest authority governs the system; it does not decide cases, because its '
      + 'determinations would be irreversible');
    }
  });

  test('a commit is exempt, because expiring a commitment erases it', async () => {
    const A = await actors();
    await ground(A, 'c5');
    const s = await seal(A.agent, { idempotencyKey: 'idem-c5', aliases: person('c5'),
      scope: 'refund', disposition: 'commit', rule: RULE,
      claw: clawFor('agent', 0) }, STRENGTHS);
    assert.equal(s.expiresAt, null,
      'a commit records what an agent told a customer; ending it is not the same as erasing it');
  });
});

describe('hardening deliberately does not touch time', () => {
  test('pressure raises authority and evidence, never the wait', async () => {
    const { harden } = await import('../../src/domain/lifecycle.js');
    const base: ClawRule = { authority: 'operator', evidenceFloor: 'internal',
      coolingOffSeconds: 900 };
    for (const tier of ['persistent', 'probing', 'sustained'] as const) {
      const { rule } = harden('bind', base, tier);
      assert.equal(rule.coolingOffSeconds, base.coolingOffSeconds,
        'pressure is raised by whoever presents a subject\u2019s aliases and is refused, so a '
        + 'third party can raise it on somebody else\u2019s determination. Authority and '
        + 'evidence can still be met \u2014 find a higher authority, find better evidence. '
        + 'Time cannot be routed around at all, so hardening it would deepen that attack '
        + 'rather than defend against anything.');
    }
  });
});
