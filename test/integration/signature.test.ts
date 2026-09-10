// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** §7.0f · A sealed record is signed at seal time, over its core, and the proof carries it. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, reevaluate } from '../../src/domain/seal.js';
import { proof, recordCore } from '../../src/domain/record.js';
import { signer } from '../../src/domain/signer.js';
import { verifyCore } from '../../src/lib/signing.js';
import { actors, person, stateOf, STRENGTHS } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };

before(async () => {
  process.env['SIGNING_KEY'] ||= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  await migrate(() => {});
});
after(async () => { await closePool(); });

describe('the signature', () => {
  test('is made at seal time over the core, verifies under the published key, and survives the record moving', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('s1'), facts: [
      { fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' } ] }, STRENGTHS);
    const out = await seal(A.agent, { idempotencyKey: 'idem-s1', aliases: person('s1'), scope: 'medicaid.renewal',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    const rec = await proof(A.operator, out.sealId!);
    assert.ok(rec.signature, 'signed');
    const key = signer()!.published();
    assert.equal(rec.signature!.kid, key.kid);
    assert.equal(verifyCore(recordCore(rec), rec.signature!, key.public_key), true);

    // The record moves; the core does not; the signature still verifies.
    await attest(A.agent, { aliases: person('s1'), facts: [
      { fact: 'household.income', type: 'int', value: 1000, source: 'state_registry' } ] }, STRENGTHS);
    await reevaluate(A.ws);
    assert.equal(await stateOf(out.sealId!), 'lapsed');
    const later = await proof(A.operator, out.sealId!);
    assert.deepEqual(later.signature, rec.signature);
    assert.equal(verifyCore(recordCore(later), later.signature!, key.public_key), true);
    assert.equal(verifyCore({ ...recordCore(later), scope: 'medicaid' }, later.signature!, key.public_key), false);
  });

  test('is absent, and said to be, when the deployment does not sign', async () => {
    const saved = process.env['SIGNING_KEY'];
    delete process.env['SIGNING_KEY'];
    try {
      const A = await actors();
      await attest(A.agent, { aliases: person('s2'), facts: [
        { fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' } ] }, STRENGTHS);
      const out = await seal(A.agent, { idempotencyKey: 'idem-s2', aliases: person('s2'), scope: 'medicaid.renewal',
        disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
      const rec = await proof(A.operator, out.sealId!);
      assert.equal(rec.signature, null);
      assert.equal(signer(), null);
    } finally {
      process.env['SIGNING_KEY'] = saved;
    }
  });
});
