// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ID_ALPHABET, newId } from '../../src/lib/ids.js';
import { KEY_ALPHABET } from '../../src/domain/auth.js';

describe('random symbols are uniform', () => {
  test('both alphabets hold exactly 32 distinct symbols, so a five-bit mask over a byte is uniform', () => {
    // 256 is a multiple of 32. Any other size would bias the low symbols;
    // the modules refuse to load if the strings are edited to another length.
    for (const a of [ID_ALPHABET, KEY_ALPHABET]) {
      assert.equal(a.length, 32);
      assert.equal(new Set(a).size, 32);
    }
  });

  test('an id uses only its alphabet and, over a sample, all of it', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const body = newId('t').slice(2);
      assert.equal(body.length, 16);
      for (const c of body) { assert.ok(ID_ALPHABET.includes(c), c); seen.add(c); }
    }
    assert.equal(seen.size, 32, 'every symbol appears in 32 000 draws');
  });
});
