// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-02, for EVERY rule the generator can produce: a remedy works, a remedy
 * is minimal, and a remedy is the same twice.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { corrections } from '../../src/domain/remedy.js';
import { evaluate, RuleTypeError } from '../../src/domain/evaluate.js';
import { representatives, type Rule, type Facts, type Fact } from '../../src/domain/rule.js';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 1500);
const opts = { numRuns: RUNS } as const;

const factName = fc.constantFrom('a', 'b', 'c.d', 'e_f');
const comparison: fc.Arbitrary<Rule> = fc.oneof(
  fc.record({ fact: factName, op: fc.constantFrom('eq', 'ne'), value: fc.boolean() }),
  fc.record({ fact: factName, op: fc.constantFrom('eq', 'ne', 'lt', 'lte', 'gt', 'gte'),
    value: fc.integer({ min: -20, max: 20 }) }),
  fc.record({ fact: factName, op: fc.constantFrom('in', 'nin'),
    value: fc.array(fc.integer({ min: -5, max: 5 }), { minLength: 1, maxLength: 3 }) }),
) as fc.Arbitrary<Rule>;
const rule: fc.Arbitrary<Rule> = fc.letrec<{ node: Rule }>((tie) => ({
  node: fc.oneof({ maxDepth: 2, depthSize: 'small' },
    comparison,
    fc.record({ all: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ any: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: tie('node') })) as fc.Arbitrary<Rule>,
})).node;
const factValue: fc.Arbitrary<Fact> = fc.oneof(
  fc.record({ type: fc.constant('bool' as const), value: fc.boolean() }),
  fc.record({ type: fc.constant('int' as const), value: fc.integer({ min: -25, max: 25 }) }),
);
const facts: fc.Arbitrary<Facts> = fc.dictionary(factName, factValue, { maxKeys: 4 });
const target = fc.constantFrom('true' as const, 'false' as const);

const tryEval = (r: Rule, f: Facts): string | null => {
  try { return evaluate(r, f); } catch (e) { if (e instanceof RuleTypeError) return null; throw e; }
};

/** A value in the cell a correction describes, found the way the verifier finds one. */
function witness(r: Rule, c: { fact: string; constraints: Array<{ op: string; value: unknown; truth: string }> }): Fact | undefined {
  for (const cand of representatives(r)?.get(c.fact) ?? []) {
    if (c.constraints.every((k) => tryEval({ fact: c.fact, op: k.op, value: k.value } as Rule, { [c.fact]: cand }) === k.truth)) return cand;
  }
  return undefined;
}

describe('fuzz: the remedy', () => {
  test('every reported set moves the rule to the target', () => {
    fc.assert(fc.property(rule, facts, target, (r, f, t) => {
      const out = corrections(r, f, t);
      for (const set of out.sets) {
        const over: Record<string, Fact> = {};
        for (const c of set) {
          const w = witness(r, c);
          assert.ok(w !== undefined, 'a constraint set describes a real cell');
          over[c.fact] = w;
        }
        assert.equal(tryEval(r, { ...f, ...over }), t);
      }
    }), opts);
  });

  test('no reported set can lose a fact and still work — minimality, checked against the evaluator', () => {
    fc.assert(fc.property(rule, facts, target, (r, f, t) => {
      const out = corrections(r, f, t);
      if (!out.exhaustive) return;
      const cells = representatives(r);
      if (cells === null) return;
      for (const set of out.sets) {
        if (set.length < 2) continue;
        // Drop each fact in turn; over the remaining facts' cells, the target must be unreachable.
        for (let d = 0; d < set.length; d++) {
          const rest = set.filter((_, i) => i !== d).map((c) => c.fact);
          const lists = rest.map((n) => cells.get(n)!);
          const total = lists.reduce((a, l) => a * l.length, 1);
          const idx = lists.map(() => 0);
          for (let k = 0; k < total; k++) {
            const over: Record<string, Fact> = {};
            rest.forEach((n, i) => { over[n] = lists[i]![idx[i]!]!; });
            assert.notEqual(tryEval(r, { ...f, ...over }), t, `dropping ${set[d]!.fact} still reached ${t}`);
            for (let i = 0; i < idx.length; i++) { if (++idx[i]! < lists[i]!.length) break; idx[i] = 0; }
          }
        }
      }
    }), opts);
  });

  test('is deterministic and never mutates its inputs', () => {
    fc.assert(fc.property(rule, facts, target, (r, f, t) => {
      const before = JSON.stringify([r, f]);
      const one = JSON.stringify(corrections(r, f, t));
      const two = JSON.stringify(corrections(structuredClone(r), structuredClone(f), t));
      assert.equal(one, two);
      assert.equal(JSON.stringify([r, f]), before);
    }), opts);
  });
});
