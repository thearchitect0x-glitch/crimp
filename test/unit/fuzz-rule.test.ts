// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Property-based tests over the grammar — the one component whose semantics can
 * never be changed once a rule has been sealed under them.
 *
 * These assert what must hold for EVERY input, not for the cases somebody
 * thought of. Ratchet's own notes record that two of its first three fuzz
 * properties passed against code that was already broken, and only deliberately
 * mutating the implementation revealed it. Each property below was checked the
 * same way: broken on purpose, watched to fail, then restored.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  validateRule, canonicalRule, factsReferenced,
  TRUE, FALSE, UNKNOWN,
  type Rule, type Facts, type Fact, type Truth,
} from '../../src/domain/rule.js';
import { evaluate, RuleTypeError } from '../../src/domain/evaluate.js';
import { ApiError } from '../../src/lib/errors.js';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 2000);
const opts = { numRuns: RUNS } as const;

/* ── Generators ─────────────────────────────────────────────────────── */

const factName = fc.constantFrom('a', 'b', 'c.d', 'e_f', 'g.h.i');

const comparison: fc.Arbitrary<Rule> = fc.oneof(
  fc.record({ fact: factName, op: fc.constantFrom('eq', 'ne'), value: fc.boolean() }),
  fc.record({
    fact: factName,
    op: fc.constantFrom('eq', 'ne', 'lt', 'lte', 'gt', 'gte'),
    value: fc.integer({ min: -1000, max: 1000 }),
  }),
  fc.record({ fact: factName, op: fc.constantFrom('eq', 'ne'), value: fc.string({ maxLength: 8 }) }),
  fc.record({
    fact: factName,
    op: fc.constantFrom('in', 'nin'),
    value: fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 5 }),
  }),
) as fc.Arbitrary<Rule>;

const rule: fc.Arbitrary<Rule> = fc.letrec<{ node: Rule }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    comparison,
    fc.record({ all: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ any: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: tie('node') }),
  ) as fc.Arbitrary<Rule>,
})).node;

const factValue: fc.Arbitrary<Fact> = fc.oneof(
  fc.record({ type: fc.constant('bool' as const), value: fc.boolean() }),
  fc.record({ type: fc.constant('int' as const), value: fc.integer({ min: -1000, max: 1000 }) }),
  fc.record({ type: fc.constant('str' as const), value: fc.string({ maxLength: 8 }) }),
  fc.record({ type: fc.constant('time' as const), value: fc.integer({ min: 0, max: 2 ** 40 }) }),
);

const facts: fc.Arbitrary<Facts> = fc.dictionary(factName, factValue, { maxKeys: 5 });

/** Evaluate, folding the type-mismatch error into a sentinel so properties can skip it. */
const TYPE_ERROR = 'type_error' as const;
function tryEval(r: Rule, f: Facts): Truth | typeof TYPE_ERROR {
  try {
    return evaluate(r, f);
  } catch (e) {
    if (e instanceof RuleTypeError) return TYPE_ERROR;
    throw e;
  }
}

/* ── Properties ─────────────────────────────────────────────────────── */

describe('fuzz: the grammar is total', () => {
  test('validateRule always returns a fact set or refuses with a 400 — it never crashes', () => {
    fc.assert(fc.property(fc.anything({ maxDepth: 4 }), (input) => {
      try {
        const out = validateRule(input);
        assert.ok(out instanceof Set && out.size > 0);
      } catch (e) {
        assert.ok(e instanceof ApiError, `unexpected ${String(e)}`);
        assert.equal(e.status, 400);
      }
    }), opts);
  });

  test('every generated rule validates, and validation agrees with introspection', () => {
    fc.assert(fc.property(rule, (r) => {
      const fromValidate = validateRule(r);
      assert.deepEqual([...fromValidate].sort(), [...factsReferenced(r)].sort());
    }), opts);
  });

  test('evaluation always yields one of exactly three truths, or a typed refusal', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const out = tryEval(r, f);
      assert.ok(out === TRUE || out === FALSE || out === UNKNOWN || out === TYPE_ERROR);
    }), opts);
  });
});

describe('fuzz: canonical form', () => {
  test('is stable — the same rule always produces the same bytes', () => {
    fc.assert(fc.property(rule, (r) => {
      assert.equal(canonicalRule(r), canonicalRule(r));
      assert.equal(canonicalRule(structuredClone(r)), canonicalRule(r));
    }), opts);
  });

  test('is order-independent for commutative operators', () => {
    fc.assert(fc.property(fc.array(comparison, { minLength: 2, maxLength: 4 }), (kids) => {
      const reversed = [...kids].reverse();
      assert.equal(canonicalRule({ all: kids }), canonicalRule({ all: reversed }));
      assert.equal(canonicalRule({ any: kids }), canonicalRule({ any: reversed }));
    }), opts);
  });

  test('never mutates the rule it is given', () => {
    fc.assert(fc.property(rule, (r) => {
      const before = JSON.stringify(r);
      canonicalRule(r);
      assert.equal(JSON.stringify(r), before);
    }), opts);
  });
});

describe('fuzz: Kleene semantics', () => {
  /**
   * The load-bearing property of the whole evaluator.
   *
   * Learning a fact may RESOLVE an unknown. It must never REVERSE something
   * already known. If this can be violated, then attesting more facts could
   * flip a determination from bind to permit without anyone deciding anything —
   * which is the silent reversal this product exists to make impossible, hiding
   * inside the product.
   */
  test('knowledge is monotone: attesting a new fact never flips a known answer', () => {
    fc.assert(fc.property(rule, facts, factName, factValue, (r, f, name, v) => {
      if (name in f) return; // only interested in genuinely new knowledge
      const before = tryEval(r, f);
      const after = tryEval(r, { ...f, [name]: v });
      if (before === TYPE_ERROR || after === TYPE_ERROR) return;
      if (before === UNKNOWN) return;            // may resolve either way
      assert.equal(after, before,
        `attesting ${name} flipped ${before} to ${after}`);
    }), opts);
  });

  test('evaluation is pure — no hidden state, no clock', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const a = tryEval(r, f);
      const b = tryEval(r, structuredClone(f) as Facts);
      assert.equal(a, b);
    }), opts);
  });

  test('double negation is the identity', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      assert.equal(tryEval({ not: { not: r } }, f), tryEval(r, f));
    }), opts);
  });

  test('De Morgan holds in three-valued logic', () => {
    fc.assert(fc.property(comparison, comparison, facts, (p, q, f) => {
      const left = tryEval({ not: { all: [p, q] } }, f);
      const right = tryEval({ any: [{ not: p }, { not: q }] }, f);
      if (left === TYPE_ERROR || right === TYPE_ERROR) return;
      assert.equal(left, right);
    }), opts);
  });

  test('a rule reading only unattested facts is always UNKNOWN', () => {
    fc.assert(fc.property(rule, (r) => {
      assert.equal(tryEval(r, {}), UNKNOWN,
        'with nothing attested there is nothing to conclude');
    }), opts);
  });
});
