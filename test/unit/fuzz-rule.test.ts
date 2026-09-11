// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
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
  validateRule, canonicalRule, factsReferenced, constantConclusion, LIMITS,
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

/**
 * The generator is capped well inside the grammar's own limits.
 *
 * It was not, originally, and 4 runs in 12 failed — fast-check picks a fresh
 * seed each run, and some seeds produced rules deeper than `LIMITS.maxDepth`,
 * which the grammar correctly refused and the properties below wrongly counted
 * as a failure. An intermittently red pipeline is worse than a red one, because
 * a team learns to re-run it rather than read it.
 *
 * The cap belongs on the generator rather than on the properties: these
 * properties exist to exercise VALID rules, and a rule the grammar refuses has
 * already been tested by `validateRule always … refuses with a 400`. The guard
 * immediately below keeps this honest if anyone widens the generator later.
 */
const rule: fc.Arbitrary<Rule> = fc.letrec<{ node: Rule }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: 'small', withCrossShrink: true },
    comparison,
    fc.record({ all: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ any: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: tie('node') }),
  ) as fc.Arbitrary<Rule>,
})).node;

function shape(r: Rule): { depth: number; nodes: number } {
  if ('all' in r || 'any' in r) {
    const kids = ('all' in r ? r.all : r.any).map(shape);
    return {
      depth: 1 + Math.max(...kids.map((k) => k.depth)),
      nodes: 1 + kids.reduce((n, k) => n + k.nodes, 0),
    };
  }
  if ('not' in r) {
    const k = shape(r.not);
    return { depth: 1 + k.depth, nodes: 1 + k.nodes };
  }
  return { depth: 1, nodes: 1 };
}

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

describe('fuzz: the generator itself stays inside the grammar', () => {
  /**
   * Regression guard. Without this, widening the generator silently
   * reintroduces a flake that only shows up in roughly one CI run in three —
   * which is exactly the kind of failure a team stops reading.
   */
  test('every generated rule is within the declared limits', () => {
    fc.assert(fc.property(rule, (r) => {
      const { depth, nodes } = shape(r);
      assert.ok(depth <= LIMITS.maxDepth, `generated depth ${depth} exceeds ${LIMITS.maxDepth}`);
      assert.ok(nodes <= LIMITS.maxNodes, `generated nodes ${nodes} exceeds ${LIMITS.maxNodes}`);
    }), opts);
  });
});

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

  /**
   * The generator can produce `any[a=1, a≠1]` by chance, and since cap-01 the
   * grammar refuses it. So the property is now two-sided: a rule is admitted
   * with the right fact set, or it is refused as a constant conclusion — and
   * then the detector must agree that it is one. Nothing else may happen.
   */
  test('every generated rule is admitted with its fact set, or refused as a constant conclusion', () => {
    fc.assert(fc.property(rule, (r) => {
      const constant = constantConclusion(r);
      if (constant === null) {
        assert.deepEqual([...validateRule(r)].sort(), [...factsReferenced(r)].sort());
      } else {
        assert.throws(() => validateRule(r), (e: unknown) =>
          e instanceof ApiError && e.code === 'constant_conclusion');
      }
    }), opts);
  });

  /**
   * A verdict of "constant" is a claim about EVERY assignment. Check it
   * against assignments the detector never chose: random typed values of the
   * kinds the rule compares against. A type error is not a counter-example.
   */
  test('a constant verdict survives random assignments it did not pick', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const c = constantConclusion(r);
      if (c === null || c.path !== 'rule') return;
      const names = [...factsReferenced(r)];
      if (!names.every((n) => n in f)) return;   // the claim is over PRESENT facts
      const out = tryEval(r, f);
      if (out === TYPE_ERROR) return;
      assert.equal(out, c.truth, `detector said ${c.truth}, evaluation said ${out}`);
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
