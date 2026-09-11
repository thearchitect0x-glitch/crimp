// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The browser verifier is a standalone page with the vectors embedded. It
 * went stale once — a 0.1 vector set and a 0.1 label on a 0.2 verifier —
 * and this is what keeps it from going stale again.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('spec/verifier.html', 'utf8');
const mjs = readFileSync('spec/verifier.mjs', 'utf8');

describe('spec/verifier.html', () => {
  test('embeds exactly the published vectors', () => {
    const m = /const VECTORS = ([\s\S]*?\n\});/.exec(html);
    assert.ok(m, 'VECTORS literal present');
    assert.deepEqual(JSON.parse(m![1]!), JSON.parse(readFileSync('spec/vectors/vectors.json', 'utf8')));
  });
  test('carries the specification\'s version', () => {
    const v = /\*\*Version ([0-9.]+)/.exec(readFileSync('docs/SPEC.md', 'utf8'))![1];
    assert.match(html, new RegExp(`Determination Format v${v!.replace('.', '\\.')}`));
  });
  test('self-tests every group the runner does', () => {
    for (const group of ['canonical', 'digest', 'evaluate', 'reasons', 'record', 'remedy', 'signature']) {
      assert.match(html, new RegExp(`VECTORS\\.${group}`), group);
    }
  });
  test('verifies the same steps as the module', () => {
    for (const step of ['rule hash', 'rule ref', 'remedy · effective', 'signature', 'reasons · accuracy', 'no subject identifier']) {
      assert.ok(html.includes(`'${step}'`), `html: ${step}`);
      assert.ok(mjs.includes(`'${step}'`), `mjs: ${step}`);
    }
  });
});
