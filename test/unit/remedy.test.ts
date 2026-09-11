// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-02 · The remedy is exact, minimal, deterministic and bounded — and
 * every set it reports actually works.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { corrections, favourable, REMEDY_BOUND, type Remedy } from '../../src/domain/remedy.js';
import { evaluate } from '../../src/domain/evaluate.js';
import { representatives, type Rule, type Facts, type Fact } from '../../src/domain/rule.js';

const cmp = (fact: string, op: string, value: unknown) => ({ fact, op, value }) as Rule;

/** Brute force: does ANY assignment over the given facts reach the target? */
function reachable(rule: Rule, facts: Facts, subset: string[], target: string): boolean {
  const cells = representatives(rule)!;
  const lists = subset.map((n) => cells.get(n)!);
  const total = lists.reduce((a, l) => a * l.length, 1);
  const idx = lists.map(() => 0);
  for (let k = 0; k < total; k++) {
    const over: Record<string, Fact> = {};
    subset.forEach((n, i) => { over[n] = lists[i]![idx[i]!]!; });
    try { if (evaluate(rule, { ...facts, ...over }) === target) return true; } catch { /* type error: not a witness */ }
    for (let i = 0; i < idx.length; i++) { if (++idx[i]! < lists[i]!.length) break; idx[i] = 0; }
  }
  return false;
}

function* subsets(items: string[], size: number): Generator<string[]> {
  if (size === 0) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
    for (const rest of subsets(items.slice(i + 1), size - 1)) yield [items[i]!, ...rest];
  }
}

/** Every set works; no smaller set works. The two halves of "minimal correction set". */
function assertSound(rule: Rule, facts: Facts, r: Remedy): void {
  assert.ok(r.sets.length > 0, 'expected at least one set');
  const size = r.sets[0]!.length;
  for (const set of r.sets) {
    assert.equal(set.length, size, 'every reported set has the minimal size');
    assert.ok(reachable(rule, facts, set.map((c) => c.fact), r.target), `set ${JSON.stringify(set.map((c) => c.fact))} works`);
  }
  const names = [...representatives(rule)!.keys()];
  for (let k = 1; k < size; k++) {
    for (const s of subsets(names, k)) {
      assert.equal(reachable(rule, facts, s, r.target), false, `a smaller set ${JSON.stringify(s)} must not work`);
    }
  }
}

describe('one condition', () => {
  test('a < 3 with a = 5, toward true: change a into the cell where a < 3', () => {
    const rule = cmp('a', 'lt', 3);
    const r = corrections(rule, { a: { type: 'int', value: 5 } }, 'true');
    assert.deepEqual(r, { target: 'true', exhaustive: true, evaluations: r.evaluations, sets: [[
      { fact: 'a', factType: 'int', constraints: [{ path: 'rule', op: 'lt', value: 3, truth: 'true' }] },
    ]] });
    assertSound(rule, { a: { type: 'int', value: 5 } }, r);
  });
  test('an absent fact can be the remedy: attest it in the right cell', () => {
    const r = corrections(cmp('a', 'eq', true), {}, 'true');
    assert.equal(r.sets.length, 1);
    assert.deepEqual(r.sets[0]![0]!.constraints, [{ path: 'rule', op: 'eq', value: true, truth: 'true' }]);
  });
  test('two cells for one fact are two remedies: any[a=1, a=2] from a=0', () => {
    const rule: Rule = { any: [cmp('a', 'eq', 1), cmp('a', 'eq', 2)] };
    const r = corrections(rule, { a: { type: 'int', value: 0 } }, 'true');
    assert.deepEqual(r.sets.map((s) => s[0]!.constraints.map((k) => k.truth)), [['false', 'true'], ['true', 'false']]);
  });
  test('already at the target: nothing to change, and that is said plainly', () => {
    const r = corrections(cmp('a', 'lt', 3), { a: { type: 'int', value: 1 } }, 'true');
    assert.deepEqual(r, { target: 'true', sets: [], exhaustive: true, evaluations: 0 });
  });
});

describe('three conditions', () => {
  const rule: Rule = { all: [cmp('a', 'lt', 3), cmp('b', 'eq', true), cmp('c', 'in', ['X', 'Y'])] };
  test('all three fail: the only minimal set is all three', () => {
    const facts: Facts = { a: { type: 'int', value: 5 }, b: { type: 'bool', value: false }, c: { type: 'str', value: 'Z' } };
    const r = corrections(rule, facts, 'true');
    assert.equal(r.sets.length, 1);
    assert.deepEqual(r.sets[0]!.map((x) => x.fact), ['a', 'b', 'c']);
    assertSound(rule, facts, r);
  });
  test('one fails: the minimal set is that one, whichever it is', () => {
    const facts: Facts = { a: { type: 'int', value: 1 }, b: { type: 'bool', value: true }, c: { type: 'str', value: 'Z' } };
    const r = corrections(rule, facts, 'true');
    assert.deepEqual(r.sets.map((s) => s.map((x) => x.fact)), [['c']]);
    assert.deepEqual(r.sets[0]![0]!.constraints, [{ path: 'all[2]', op: 'in', value: ['X', 'Y'], truth: 'true' }]);
    assertSound(rule, facts, r);
  });
  test('all hold, toward false: three independent single-fact remedies, in a stable order', () => {
    const facts: Facts = { a: { type: 'int', value: 1 }, b: { type: 'bool', value: true }, c: { type: 'str', value: 'X' } };
    const r = corrections(rule, facts, 'false');
    assert.deepEqual(r.sets.map((s) => s.map((x) => x.fact)), [['a'], ['b'], ['c']]);
    assert.deepEqual(r.sets[0]![0]!.constraints[0]!.truth, 'false');
    assertSound(rule, facts, r);
  });
  test('a negated clause: the constraint says which truth the leaf must take', () => {
    const neg: Rule = { all: [cmp('a', 'lt', 3), { not: cmp('b', 'eq', 'blocked') }] };
    const facts: Facts = { a: { type: 'int', value: 1 }, b: { type: 'str', value: 'blocked' } };
    const r = corrections(neg, facts, 'true');
    assert.deepEqual(r.sets, [[{ fact: 'b', factType: 'str',
      constraints: [{ path: 'all[1].not', op: 'eq', value: 'blocked', truth: 'false' }] }]]);
  });
});

describe('ten conditions', () => {
  const rule: Rule = { all: Array.from({ length: 10 }, (_, i) => cmp(`f${i}`, 'gte', 1)) };
  test('two fail among ten: the size-two set is found, exhaustively, well inside the bound', () => {
    const facts: Facts = Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
      [`f${i}`, { type: 'int', value: i === 3 || i === 7 ? 0 : 1 }]));
    const r = corrections(rule, facts, 'true');
    assert.deepEqual(r.sets.map((s) => s.map((x) => x.fact)), [['f3', 'f7']]);
    assert.equal(r.exhaustive, true);
    assert.ok(r.evaluations < 200, `spent ${r.evaluations}`);
    assertSound(rule, facts, r);
  });
  test('a disjunction of ten, none holding: ten single-fact remedies', () => {
    const any: Rule = { any: (rule as { all: Rule[] }).all };
    const facts: Facts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: 'int', value: 0 }]));
    const r = corrections(any, facts, 'true');
    assert.equal(r.sets.length, 10);
    assert.ok(r.sets.every((s) => s.length === 1));
    assertSound(any, facts, r);
  });
  test('all ten fail: the answer needs all ten, found after every smaller subset is ruled out', () => {
    const facts: Facts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: 'int', value: 0 }]));
    const r = corrections(rule, facts, 'true');
    assert.equal(r.exhaustive, true);
    assert.equal(r.sets.length, 1);
    assert.equal(r.sets[0]!.length, 10);
    // 2^10 − 1 subsets, one cell each: every subset tried exactly once.
    assert.equal(r.evaluations, 1023);
  });
  test('seventeen failing conditions is past the bound, and the remedy says so rather than guessing', () => {
    const big: Rule = { all: Array.from({ length: 17 }, (_, i) => cmp(`f${i}`, 'gte', 1)) };
    const facts: Facts = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: 'int', value: 0 }]));
    const r = corrections(big, facts, 'true');
    assert.equal(r.exhaustive, false);
    assert.deepEqual(r.sets, []);
    assert.equal(r.evaluations, REMEDY_BOUND);
  });
});

describe('determinism', () => {
  test('the same inputs give byte-identical output, and the order is the rule\'s, not the search\'s', () => {
    const rule: Rule = { any: [cmp('z', 'eq', 1), cmp('m', 'eq', 1), cmp('a', 'eq', 1)] };
    const facts: Facts = { z: { type: 'int', value: 0 }, m: { type: 'int', value: 0 }, a: { type: 'int', value: 0 } };
    const one = corrections(rule, facts, 'true');
    const two = corrections(structuredClone(rule), structuredClone(facts), 'true');
    assert.equal(JSON.stringify(one), JSON.stringify(two));
    assert.deepEqual(one.sets.map((s) => s[0]!.fact), ['a', 'm', 'z']);
  });
  test('the bound is stated', () => { assert.equal(REMEDY_BOUND, 65536); });
  test('the favourable direction follows the disposition', () => {
    assert.equal(favourable('bind'), 'false');
    assert.equal(favourable('permit'), 'true');
    assert.equal(favourable('commit'), null);
  });
});
