// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Two more axes on a reversal: how many, and from where.
 *
 * Four-eyes is standard for consequential irreversible acts in every regulated
 * industry, and reversing a standing determination about a person is one. It
 * was inexpressible: a claw needed one credential of sufficient authority and
 * nothing further could be asked for.
 *
 * Jurisdiction is the same shape of idea. Authority here is a property of the
 * credential and unforgeable by the caller, so binding a credential to a place
 * turns "every reversal affecting a person here was performed under authority
 * bound here" from a promise in a contract into a refusal in code.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, claw } from '../../src/domain/seal.js';
import { mintKey, verifyKey, SCOPES, type Principal } from '../../src/domain/auth.js';
import { assertTightening, QUORUM_WINDOW_SECONDS } from '../../src/domain/authority.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, hash64, freshWorkspace, STRENGTHS, type Actors } from '../helpers.js';
import type { Authority, ClawRule } from '../../src/domain/authority.js';

const RULE = { fact: 'carrier.delivered', op: 'eq', value: false };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    return true;
  }, why);
}

async function ground(A: Actors, tag: string): Promise<void> {
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] }, STRENGTHS);
}

/** A second, independent credential at the same authority. */
async function another(ws: string, authority: Authority, jurisdiction?: string)
: Promise<Principal> {
  const k = await mintKey({ workspaceId: ws, authority, scopes: [...SCOPES],
    label: `second-${authority}`, by: null,
    ...(jurisdiction ? { jurisdiction } : {}) });
  return verifyKey(k.key);
}

const EV = { evidenceSha256: hash64('e'), evidenceClass: 'receipt' as const };

/* ── Quorum ──────────────────────────────────────────────────────────── */

describe('dual control on a reversal', () => {
  test('one signature leaves the determination standing', async () => {
    const A = await actors();
    await ground(A, 'q1');
    const s = await seal(A.agent, { idempotencyKey: 'idem-q1', aliases: person('q1'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal',
        coolingOffSeconds: 0, quorum: 2 } }, STRENGTHS);

    const first = await claw(A.operator, { sealId: s.sealId!, ...EV });
    assert.equal(first.state, 'pending');
    assert.equal(first.signaturesNeeded, 1);

    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM seals WHERE id = $1', [s.sealId]);
    assert.equal(rows[0]?.state, 'sealed',
      'a quorum that never completes leaves the determination standing, which is the safe direction');
  });

  test('a second, different credential completes it', async () => {
    const A = await actors();
    await ground(A, 'q2');
    const s = await seal(A.agent, { idempotencyKey: 'idem-q2', aliases: person('q2'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal',
        coolingOffSeconds: 0, quorum: 2 } }, STRENGTHS);

    assert.equal((await claw(A.operator, { sealId: s.sealId!, ...EV })).state, 'pending');
    const second = await another(A.ws, 'operator');
    assert.equal((await claw(second, { sealId: s.sealId!, ...EV })).state, 'clawed');

    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM seals WHERE id = $1', [s.sealId]);
    assert.equal(rows[0]?.state, 'clawed');
  });

  test('the same key signing twice is one signature typed twice', async () => {
    const A = await actors();
    await ground(A, 'q3');
    const s = await seal(A.agent, { idempotencyKey: 'idem-q3', aliases: person('q3'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal',
        coolingOffSeconds: 0, quorum: 2 } }, STRENGTHS);

    for (let i = 0; i < 3; i++) {
      assert.equal((await claw(A.operator, { sealId: s.sealId!, ...EV })).state, 'pending',
        'four-eyes means two people, not one person twice');
    }
    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM seals WHERE id = $1', [s.sealId]);
    assert.equal(rows[0]?.state, 'sealed');
  });

  test('the second signer clears every bar independently', async () => {
    const A = await actors();
    await ground(A, 'q4');
    const s = await seal(A.agent, { idempotencyKey: 'idem-q4', aliases: person('q4'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'receipt',
        coolingOffSeconds: 0, quorum: 2 } }, STRENGTHS);

    await claw(A.operator, { sealId: s.sealId!, ...EV });
    const second = await another(A.ws, 'operator');
    // A quorum adds a requirement; it never relaxes one. The second signer
    // does not inherit the first signer's standing.
    await refuses(() => claw(second, { sealId: s.sealId!,
      evidenceSha256: hash64('weak'), evidenceClass: 'internal' }),
    'insufficient_evidence', 'the evidence floor still applies to the second signature');
  });

  test('a standing signature expires, so two unrelated decisions are not a quorum', async () => {
    const A = await actors();
    await ground(A, 'q5');
    const s = await seal(A.agent, { idempotencyKey: 'idem-q5', aliases: person('q5'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal',
        coolingOffSeconds: 0, quorum: 2 } }, STRENGTHS);

    await claw(A.operator, { sealId: s.sealId!, ...EV });
    // Age the standing half past the window.
    await getPool().query(
      `UPDATE seal_events SET occurred_at = now() - ($2 || ' seconds')::interval
        WHERE seal_id = $1 AND kind = 'claw_pending'`,
      [s.sealId, String(QUORUM_WINDOW_SECONDS + 60)]);

    const second = await another(A.ws, 'operator');
    assert.equal((await claw(second, { sealId: s.sealId!, ...EV })).state, 'pending',
      'a week-old signature is not half of a decision');
  });

  test('quorum 1 is unchanged, and is the default', async () => {
    const A = await actors();
    await ground(A, 'q6');
    const s = await seal(A.agent, { idempotencyKey: 'idem-q6', aliases: person('q6'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 } },
    STRENGTHS);
    assert.equal((await claw(A.operator, { sealId: s.sealId!, ...EV })).state, 'clawed');
  });
});

/* ── Jurisdiction ────────────────────────────────────────────────────── */

describe('where the reversing human must be', () => {
  test('a credential bound elsewhere cannot reverse', async () => {
    const ws = await freshWorkspace();
    const us = await another(ws, 'agent', 'US');
    const usOp = await another(ws, 'operator', 'US');
    await attest(us, { aliases: person('j1'), facts: [
      { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);
    const s = await seal(us, { idempotencyKey: 'idem-j1', aliases: person('j1'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal',
        coolingOffSeconds: 0, jurisdiction: 'US' } }, STRENGTHS);

    const elsewhere = await another(ws, 'operator', 'IN');
    await refuses(() => claw(elsewhere, { sealId: s.sealId!, ...EV }),
      'wrong_jurisdiction',
      'a procurement can require this, and it is a refusal rather than a promise');

    const unbound = await another(ws, 'operator');
    await refuses(() => claw(unbound, { sealId: s.sealId!, ...EV }),
      'wrong_jurisdiction', 'unbound is not the same as bound here');

    assert.equal((await claw(usOp, { sealId: s.sealId!, ...EV })).state, 'clawed');
  });

  test('a sealer may only demand the place its own credential is bound to', async () => {
    const ws = await freshWorkspace();
    const us = await another(ws, 'agent', 'US');
    await attest(us, { aliases: person('j2'), facts: [
      { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);
    await refuses(() => seal(us, { idempotencyKey: 'idem-j2', aliases: person('j2'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal',
        coolingOffSeconds: 0, jurisdiction: 'ZZ' } }, STRENGTHS),
    'invalid_claw_rule',
    'naming a place no credential holds is a determination nobody can ever lift');
  });

  test('an unbound key cannot require a jurisdiction of its reverser', async () => {
    const A = await actors();
    await ground(A, 'j3');
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-j3', aliases: person('j3'),
      scope: 'refund', disposition: 'bind', rule: RULE,
      claw: { authority: 'operator', evidenceFloor: 'internal',
        coolingOffSeconds: 0, jurisdiction: 'US' } }, STRENGTHS),
    'invalid_claw_rule', 'you cannot bind a reverser to a place you are not bound to yourself');
  });

  test('a bound key cannot mint its way out of its own jurisdiction', async () => {
    const ws = await freshWorkspace();
    const us = await another(ws, 'principal', 'US');
    await assert.rejects(
      () => mintKey({ workspaceId: ws, authority: 'operator', scopes: ['seals:claw'],
        label: 'offshore', by: us, jurisdiction: 'IN' }),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'forbidden');
        return true;
      });
    await assert.rejects(
      () => mintKey({ workspaceId: ws, authority: 'operator', scopes: ['seals:claw'],
        label: 'unbound', by: us }),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'forbidden');
        return true;
      }, 'minting an unbound key would be the same escape by omission');
  });
});

/* ── What hardening may and may not raise ────────────────────────────── */

describe('pressure raises only the bars a person can clear by acting', () => {
  test('it never raises quorum or moves jurisdiction', async () => {
    const { harden } = await import('../../src/domain/lifecycle.js');
    const base: ClawRule = { authority: 'operator', evidenceFloor: 'internal',
      coolingOffSeconds: 900, quorum: 1, jurisdiction: 'US' };
    for (const tier of ['persistent', 'probing', 'sustained'] as const) {
      const { rule } = harden('bind', base, tier);
      assert.equal(rule.quorum, 1,
        'a person seeking relief cannot produce a second signer, and a third party can raise '
        + 'pressure on their determination — so raising quorum would arm that attack');
      assert.equal(rule.coolingOffSeconds, base.coolingOffSeconds, 'nor can they hurry time');
      assert.equal(rule.jurisdiction, 'US', 'and dropping this would loosen the rule');
    }
  });

  test('tightening accepts more and never fewer', () => {
    const base: ClawRule = { authority: 'operator', evidenceFloor: 'internal',
      coolingOffSeconds: 60, quorum: 2, jurisdiction: 'US' };
    assertTightening(base, { ...base, quorum: 2 });
    for (const loosened of [
      { ...base, quorum: 1 as const },
      { ...base, jurisdiction: null },
      { ...base, jurisdiction: 'IN' },
    ]) {
      assert.throws(() => assertTightening(base, loosened),
        (e: unknown) => e instanceof ApiError && e.code === 'claw_rule_loosened');
    }
  });
});
