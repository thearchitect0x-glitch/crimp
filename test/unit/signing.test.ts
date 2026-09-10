// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** §7.0f · Ed25519 over the canonical core: deterministic, key-bound, tamper-evident. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Signer, verifyCore, kidOf } from '../../src/lib/signing.js';

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
