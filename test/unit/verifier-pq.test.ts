// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The independent verifier checks the post-quantum signature where it can
 * (node:crypto) and says so; absent is not a finding; a wrong key is.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Signer, generatePqKeyPair, pqSupported } from '../../src/lib/signing.js';
const NO_PQ = pqSupported() ? false : 'ML-DSA-65 needs Node 25 or OpenSSL 3.5';
// The verifier is plain JavaScript by design (it must run with nothing but a browser);
// resolved at run time so the type checker does not demand a declaration for it.
const VERIFIER = '../../spec/verifier.mjs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { verify, verifySignaturePq, core } = (await import(VERIFIER)) as any;

const SEED = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors/vectors.json', import.meta.url), 'utf8'));
const signed = (vectors.signature as Array<{ record: Record<string, unknown>; valid: boolean }>).find((c) => c.valid)!.record;

describe('verifier · post-quantum signature', () => {
  test('a record signed twice reports both steps, and the second breaks on tampering', { skip: NO_PQ }, async () => {
    const pq = generatePqKeyPair();
    const sg = new Signer(SEED, { pqPrivateKeyDer: pq.privateKeyDerBase64 });
    const { signature: _drop, ...bare } = signed;
    const det: Record<string, unknown> = { ...bare };
    // Re-sign the vector's core under both keys so the two agree with the same bytes.
    det['signature'] = sg.signCore(core(det));
    det['signature_pq'] = sg.signCorePq(core(det));
    const keys = sg.publishedKeys();
    const r = await verify(det, {}, { keys });
    const s1 = r.steps.find((s: { step: string }) => s.step === 'signature');
    const s2 = r.steps.find((s: { step: string }) => s.step === 'signature · post-quantum');
    assert.equal(s1?.ok, true);
    assert.equal(s2?.ok, true, s2?.detail);
    const tampered = { ...det, scope: 'somewhere.else' };
    const t2 = await verifySignaturePq(tampered, keys);
    assert.equal(t2.ok, false);
    const unknown = await verifySignaturePq(det, [keys[0]!]);
    assert.equal(unknown.ok, null, 'no published key: not checked, not invalid');
  });

  test('a record without a second signature reports no post-quantum step at all', async () => {
    const r = await verify(signed, {}, { keys: [new Signer(SEED).published()] });
    assert.equal(r.steps.some((s: { step: string }) => s.step === 'signature · post-quantum'), false);
    assert.equal(r.steps.find((s: { step: string }) => s.step === 'signature')?.ok, true);
  });

  test('the site serves the same verifier', () => {
    assert.equal(readFileSync('web/spec/verifier.mjs', 'utf8'), readFileSync('spec/verifier.mjs', 'utf8'));
  });
});
