// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** §7.0f · Ed25519 over the canonical core: deterministic, key-bound, tamper-evident. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Signer, verifyCore, verifyCorePq, kidOf, generatePqKeyPair, pqSupported } from '../../src/lib/signing.js';
const NO_PQ = pqSupported() ? false : 'ML-DSA-65 needs Node 25 or OpenSSL 3.5';

const SEED = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OTHER = Buffer.alloc(32, 7).toString('base64');
const core = { seal_id: 's1', scope: 'refund', disposition: 'bind', rule: { fact: 'a', op: 'eq', value: 1 },
  rule_hash: 'f'.repeat(64), grammar_version: '1', sealed_by: 'agent', sealed_at: '2026-09-10T00:00:00.000Z',
  expires_at: null, as_of: null, rule_ref: null, reasons: [], facts: [], remedy: null };

describe('record signing', () => {
  test('is deterministic and verifies under the published key', () => {
    const sg = new Signer(SEED);
    const a = sg.signCore(core);
    const b = sg.signCore(structuredClone(core));
    assert.equal(a.sig, b.sig);
    assert.equal(a.alg, 'ed25519');
    assert.equal(a.kid, sg.published().kid);
    assert.equal(Buffer.from(a.sig, 'base64').length, 64);
    assert.equal(verifyCore(core, a, sg.published().public_key), true);
  });
  test('fails under another key, and on any change to the core', () => {
    const sg = new Signer(SEED);
    const sig = sg.signCore(core);
    assert.equal(verifyCore(core, sig, new Signer(OTHER).published().public_key), false);
    assert.equal(verifyCore({ ...core, disposition: 'permit' }, sig, sg.published().public_key), false);
    assert.equal(verifyCore({ ...core, rule: { fact: 'a', op: 'eq', value: 2 } }, sig, sg.published().public_key), false);
  });
  test('key order in the core does not matter; the canonical form does', () => {
    const sg = new Signer(SEED);
    const reordered = Object.fromEntries(Object.entries(core).reverse());
    assert.equal(sg.signCore(reordered).sig, sg.signCore(core).sig);
  });
  test('the kid is the first 16 hex of sha256 of the raw public key; a bad seed is refused', () => {
    const sg = new Signer(SEED);
    assert.equal(sg.kid, kidOf(sg.publicKeyRaw));
    assert.match(sg.kid, /^[0-9a-f]{16}$/);
    assert.equal(sg.publicKeyRaw.length, 32);
    assert.throws(() => new Signer('dG9vc2hvcnQ='), /32-byte/);
  });
});

describe('the post-quantum second signature', () => {
  test('verifies under the published ml-dsa-65 key, fails on any change, and is absent when there is no key', { skip: NO_PQ }, () => {
    const pq = generatePqKeyPair();
    const sg = new Signer(SEED, { pqPrivateKeyDer: pq.privateKeyDerBase64 });
    assert.equal(sg.hasPq, true);
    const a = sg.signCorePq(core)!;
    assert.equal(a.alg, 'ml-dsa-65');
    assert.equal(a.kid, pq.kid);
    assert.equal(Buffer.from(a.sig, 'base64').length, 3309);
    assert.equal(verifyCorePq(core, a, pq.publicKeyDerBase64), true);
    assert.equal(verifyCorePq({ ...core, scope: 'refund.x' }, a, pq.publicKeyDerBase64), false);
    assert.equal(verifyCorePq(core, a, generatePqKeyPair().publicKeyDerBase64), false);
    assert.equal(new Signer(SEED).signCorePq(core), null);
    assert.equal(new Signer(SEED).hasPq, false);
  });

  test('refuses a key of the wrong kind', { skip: NO_PQ }, () => {
    // An Ed25519 PKCS#8 handed in as the post-quantum key.
    const wrong = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED, 'base64')]).toString('base64');
    assert.throws(() => new Signer(SEED, { pqPrivateKeyDer: wrong }), /ml-dsa-65/);
  });

  test('previous keys are published beside the current ones, and never sign', { skip: NO_PQ }, () => {
    const older = new Signer(OTHER);
    const pq = generatePqKeyPair();
    const sg = new Signer(SEED, { pqPrivateKeyDer: pq.privateKeyDerBase64, previousPublicKeys: [older.published().public_key] });
    const keys = sg.publishedKeys();
    assert.deepEqual(keys.map((k) => [k.alg, k.status]), [['ed25519', 'current'], ['ml-dsa-65', 'current'], ['ed25519', 'previous']]);
    assert.equal(keys[2]!.kid, older.kid);
    // A record signed under the older key still verifies against the published set.
    const sig = older.signCore(core);
    const key = keys.find((k) => k.kid === sig.kid)!;
    assert.equal(verifyCore(core, sig, key.public_key), true);
    assert.equal(sg.signCore(core).kid, sg.kid, 'the current key signs; the previous one only verifies');
    assert.throws(() => new Signer(SEED, { previousPublicKeys: ['AAAA'] }), /32-byte/);
  });
});

describe('a runtime without ML-DSA', () => {
  test('refuses a post-quantum key loudly rather than issuing records without the second signature', { skip: pqSupported() ? 'this runtime has ML-DSA-65' : false }, () => {
    assert.throws(() => new Signer(SEED, { pqPrivateKeyDer: 'AAAA' }), /cannot use ml-dsa-65/);
    assert.equal(new Signer(SEED).signCorePq(core), null);
  });
});
