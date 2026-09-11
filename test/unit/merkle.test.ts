// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { root, path, rootFromPath, leafHash, nodeHash } from '../../src/lib/merkle.js';

const leaf = (i: number) => createHash('sha256').update(`leaf-${i}`).digest('hex');

describe('RFC 6962 tree', () => {
  test('the empty tree is sha256 of nothing, and one leaf is its leaf hash', () => {
    assert.equal(root([]), createHash('sha256').digest('hex'));
    assert.equal(root([leaf(0)]), leafHash(leaf(0)));
  });
  test('every path reaches the root, for every size up to seventeen, and a wrong leaf does not', () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leaf(i));
      const r = root(leaves);
      for (let i = 0; i < n; i++) {
        assert.equal(rootFromPath(leaves[i]!, path(leaves, i)), r, `n=${n} i=${i}`);
        assert.notEqual(rootFromPath(leaf(99), path(leaves, i)), r);
      }
    }
  });
  test('the split is at the largest power of two below n (RFC 6962 §2.1)', () => {
    const l = [leaf(0), leaf(1), leaf(2)];
    assert.equal(root(l), nodeHash(nodeHash(leafHash(l[0]!), leafHash(l[1]!)), leafHash(l[2]!)));
    assert.equal(path(l, 2).length, 1);
    assert.deepEqual(path(l, 2)[0], { hash: nodeHash(leafHash(l[0]!), leafHash(l[1]!)), side: 'left' });
  });
});
