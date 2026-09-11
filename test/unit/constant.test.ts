// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * F1 · A rule that is the same under every value of its facts decides nothing
 * about them. It can only test whether they were attested, which is the
 * presence operator the grammar withholds, rebuilt from parts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateRule, constantConclusion, CONSTANT_CHECK_BOUND } from '../../src/domain/rule.js';
import { ApiError } from '../../src/lib/errors.js';

const refused = (rule: unknown, path: string, truth: string): void => {
  assert.throws(() => validateRule(rule), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'constant_conclusion');
    assert.equal((e.detail as { path: string }).path, path);
    assert.equal((e.detail as { truth: string }).truth, truth);
    return true;
  });
};
const admitted = (rule: unknown): void => { assert.ok(validateRule(rule).size > 0); };

describe('constant conclusions are refused', () => {
  test('the smuggled presence test: any[a=1, a≠1]', () => {
    refused({ any: [{ fact: 'a', op: 'eq', value: 1 }, { fact: 'a', op: 'ne', value: 1 }] }, 'rule', 'true');
  });
  test('its contradiction: all[a=1, a≠1]', () => {
    refused({ all: [{ fact: 'a', op: 'eq', value: 1 }, { fact: 'a', op: 'ne', value: 1 }] }, 'rule', 'false');
  });
  test('a bool has two values, and naming both is one: any[a=true, a=false]', () => {
    refused({ any: [{ fact: 'a', op: 'eq', value: true }, { fact: 'a', op: 'eq', value: false }] }, 'rule', 'true');
  });
  test('a set over booleans is refused by the grammar — it could never evaluate', () => {
    assert.throws(() => validateRule({ fact: 'a', op: 'in', value: [true, false] }), (e: unknown) =>
      e instanceof ApiError && e.code === 'invalid_rule');
  });
  test('ordered comparisons that cover the line: any[a<5, a>=5], any[a<5, a>3]', () => {
    refused({ any: [{ fact: 'a', op: 'lt', value: 5 }, { fact: 'a', op: 'gte', value: 5 }] }, 'rule', 'true');
    refused({ any: [{ fact: 'a', op: 'lt', value: 5 }, { fact: 'a', op: 'gt', value: 3 }] }, 'rule', 'true');
  });
  test('sets that cover every string: any[s in [A,B], s nin [A]]', () => {
    refused({ any: [{ fact: 's', op: 'in', value: ['A', 'B'] }, { fact: 's', op: 'nin', value: ['A'] }] },
      'rule', 'true');
  });
  test('buried inside a larger rule, the path names it', () => {
    refused({ all: [
      { fact: 'b', op: 'lt', value: 5 },
      { any: [{ fact: 'a', op: 'eq', value: 1 }, { fact: 'a', op: 'ne', value: 1 }] },
    ] }, 'all[1]', 'true');
    refused({ not: { all: [{ fact: 'a', op: 'eq', value: true }, { fact: 'a', op: 'eq', value: false }] } },
      'rule', 'true');
  });
  test('across two facts, within the bound: any[a=1, a≠1, b<3]', () => {
    // The whole rule is constant (the a-clauses make it so); found at the root.
    refused({ any: [
      { fact: 'a', op: 'eq', value: 1 }, { fact: 'a', op: 'ne', value: 1 }, { fact: 'b', op: 'lt', value: 3 },
    ] }, 'rule', 'true');
  });
});

describe('near misses are admitted', () => {
  test('a gap in the line: any[a<5, a>5] is false at 5', () => {
    admitted({ any: [{ fact: 'a', op: 'lt', value: 5 }, { fact: 'a', op: 'gt', value: 5 }] });
  });
  test('a one-sided bound: a >= 0', () => {
    admitted({ fact: 'a', op: 'gte', value: 0 });
  });
  test('a set that does not cover: s in [A, B]', () => {
    admitted({ fact: 's', op: 'in', value: ['A', 'B'] });
  });
  test('genuinely joint conditions: all[any[a=1, b=1], a≠1]', () => {
    admitted({ all: [
      { any: [{ fact: 'a', op: 'eq', value: 1 }, { fact: 'b', op: 'eq', value: 1 }] },
      { fact: 'a', op: 'ne', value: 1 },
    ] });
  });
  test('the production rule in every other test', () => {
    admitted({ all: [
      { fact: 'carrier.delivered', op: 'eq', value: false },
      { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
    ] });
  });
});

describe('the bound', () => {
  test('is stated, and a multi-fact rule beyond it is not judged', () => {
    assert.equal(CONSTANT_CHECK_BOUND, 65536);
    // 17 facts × 3 cells each = 3^17 ≈ 1.3e8 assignments: unbounded, so the
    // root is skipped. Each single-fact leaf is still checked (and admitted).
    const leaves = Array.from({ length: 17 }, (_, i) => ({ fact: `f${i}`, op: 'gte', value: 0 }));
    assert.equal(constantConclusion({ any: leaves as never }), null);
    // But a single-fact presence test among them is still found, because a
    // single-fact subtree is always checked.
    const withProbe = [...leaves.slice(0, 16),
      { any: [{ fact: 'z', op: 'eq', value: 1 }, { fact: 'z', op: 'ne', value: 1 }] }];
    const found = constantConclusion({ all: withProbe as never });
    assert.equal(found?.path, 'all[16]');
  });
  test('reports how many assignments it examined', () => {
    const c = constantConclusion({ any: [{ fact: 'a', op: 'eq', value: 1 }, { fact: 'a', op: 'ne', value: 1 }] });
    assert.deepEqual(c, { truth: 'true', path: 'rule', assignments: 3 });
  });
});
