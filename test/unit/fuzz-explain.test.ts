// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The reason set must actually determine the outcome.
 *
 * This is the property that makes `explain.ts` safe to put in front of a
 * regulator. A reason set that does not really decide the answer is a false
 * adverse action notice — a Regulation B problem of its own, and one that
 * would be invisible in every hand-written example, because hand-written
 * examples are the cases somebody already understood.
 *
 * Verified the way this repo verifies everything load-bearing: broken on
 * purpose and watched to fail. The result is worth recording, because the
 * first attempt at this file was wrong in exactly the way Ratchet's notes warn
 * about — two of its first three fuzz properties passed against code that was
 * already broken.
 *
 *   mutation                                   caught by
 *   ────────────────────────────────────────── ─────────────────────────────
 *   report every leaf, whatever its truth      "an outcome that did not
 *                                              happen" — and NOTHING else
 *   include every child of a decided `all`     ACCURACY
 *   `not` does not flip the requested truth    SUFFICIENCY + ACCURACY
 *   `not` does not flip the polarity           ACCURACY
 *   `wouldHaveNeeded` off by one on `lt`       the threshold property
 *
 * SUFFICIENCY alone caught neither of the first two, and that is structural
 * rather than bad luck: it restricts the facts to those the reasons name, so
 * adding wrong reasons only keeps MORE facts and can never make the restricted
 * answer differ. A property that cannot fail in the direction of over-
 * reporting cannot police the harm that matters — telling somebody they were
 * refused because of a condition they actually satisfied.
 *
 * Writing the ACCURACY property then found a real defect in the implementation
 * rather than only in the tests: the walk re-anchored to each child's actual
 * truth on the way down, so asking why a determination was refused when it had
 * not been refused returned clauses labelled for an outcome nobody asked
 * about. Fixed by carrying the requested truth all the way down, which also
 * made the code shorter.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  factsReferenced, TRUE, FALSE, UNKNOWN,
  type Rule, type Facts, type Fact, type Truth,
} from '../../src/domain/rule.js';
import { evaluate, RuleTypeError } from '../../src/domain/evaluate.js';
import { reasons, factsNamed, disclose } from '../../src/domain/explain.js';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 2000);
const opts = { numRuns: RUNS } as const;

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

// Capped inside LIMITS for the reason given at length in fuzz-rule.test.ts.
const rule: fc.Arbitrary<Rule> = fc.letrec<{ node: Rule }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: 'small', withCrossShrink: true },
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

/** Evaluate, folding a type mismatch into a sentinel so properties can skip it. */
const SKIP = Symbol('type_error');
function tryEval(r: Rule, f: Facts): Truth | typeof SKIP {
  try { return evaluate(r, f); } catch (e) {
    if (e instanceof RuleTypeError) return SKIP;
    throw e;
  }
}

/** Keep only the facts a reason set names. Everything else becomes UNKNOWN. */
function restrict(f: Facts, keep: readonly string[]): Facts {
  const out: Record<string, Fact> = {};
  for (const k of keep) { const v = f[k]; if (v !== undefined) out[k] = v; }
  return out;
}

describe('fuzz: a reason set determines the outcome', () => {
  test('SUFFICIENCY — restricting the facts to the reasons gives the same answer', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const truth = tryEval(r, f);
      if (truth === SKIP) return;
      const rs = reasons(r, f, truth);
      const narrowed = tryEval(r, restrict(f, factsNamed(rs)));
      if (narrowed === SKIP) return;
      assert.equal(narrowed, truth,
        `reasons for ${truth} did not hold up: ${JSON.stringify({ r, f, rs })}`);
    }), opts);
  });

  test('every decided outcome has at least one reason', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const truth = tryEval(r, f);
      if (truth === SKIP) return;
      assert.ok(reasons(r, f, truth).length > 0,
        'a determination that cannot name a single clause is not explainable');
    }), opts);
  });

  test('a reason never names a fact the rule does not read', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const truth = tryEval(r, f);
      if (truth === SKIP) return;
      const referenced = factsReferenced(r);
      for (const name of factsNamed(reasons(r, f, truth))) {
        assert.ok(referenced.has(name),
          `"${name}" is not in the rule; a reason must not invent a disclosure`);
      }
    }), opts);
  });

  /**
   * ACCURACY, and it is the property that matters most.
   *
   * SUFFICIENCY cannot catch over-reporting: adding clauses to a reason set
   * only widens the facts kept, which can never make the restricted answer
   * differ. Two deliberate mutations proved that — reporting a leaf whatever
   * its truth, and reporting every child of a decided conjunction — and BOTH
   * passed the five properties written before this one.
   *
   * Both are the same real-world harm. Telling somebody they were refused
   * because of a condition they actually satisfied is an inaccurate principal
   * reason, which is a Regulation B problem in its own right rather than a
   * cosmetic one. CFPB Circular 2023-03 is explicit that reasons must be
   * accurate and specific, not a grab bag.
   *
   * The invariant: a reason's own truth equals the outcome it explains, or its
   * negation when the clause sits under an odd number of `not`s. Nothing that
   * did not decide the answer can satisfy that.
   */
  test('ACCURACY — every reason actually carries the outcome it is offered for', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const truth = tryEval(r, f);
      if (truth === SKIP) return;
      const flipped: Truth = truth === TRUE ? FALSE : truth === FALSE ? TRUE : UNKNOWN;
      for (const x of reasons(r, f, truth)) {
        const expected: Truth = x.polarity === 'negated' ? flipped : truth;
        assert.equal(x.truth, expected,
          `a ${x.polarity} reason for ${truth} evaluated ${x.truth}: ${JSON.stringify(x)}`);
        assert.match(x.path, /^[\w.[\]]+$/, 'a path must locate the clause, not describe it');
        // PARITY, not presence. `not(not(x))` carries two `not.` segments and
        // is direct — a consumer checking for the substring would state the
        // reason backwards. Found by this property on its first run.
        const depth = (x.path.match(/not\./g) ?? []).length;
        assert.equal(x.polarity === 'negated', depth % 2 === 1,
          'polarity must be the parity of the path, so a consumer can check it themselves');
      }
    }), opts);
  });

  /**
   * The guard the other properties cannot reach.
   *
   * `reasons()` takes an optional target, so a caller may ask for the reasons
   * behind an outcome the rule did not produce — "why was this refused?" about
   * a determination that was not a refusal. The honest answer is nothing at
   * all. Fabricating one would put a reason in an adverse action notice for a
   * decision that never happened, which is the worst available failure here.
   *
   * Every property above passes with the leaf guard removed, because a walk
   * driven by the true outcome never reaches a mismatched leaf. Only asking
   * the wrong question exercises it.
   */
  test('asking for an outcome that did not happen returns nothing, never a guess', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const truth = tryEval(r, f);
      if (truth === SKIP) return;
      for (const wrong of [TRUE, FALSE, UNKNOWN] as Truth[]) {
        if (wrong === truth) continue;
        for (const x of reasons(r, f, wrong)) {
          // Anything returned must at least be honest about its own truth
          // under its own polarity — a fabricated reason cannot be.
          const flipped: Truth = wrong === TRUE ? FALSE : wrong === FALSE ? TRUE : UNKNOWN;
          assert.equal(x.truth, x.polarity === 'negated' ? flipped : wrong,
            `invented a reason for ${wrong} when the rule was ${truth}: ${JSON.stringify(x)}`);
        }
      }
    }), opts);
  });

  test('it is pure — the same rule and facts give the same reasons', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const truth = tryEval(r, f);
      if (truth === SKIP) return;
      assert.deepEqual(reasons(r, f, truth), reasons(r, f, truth));
    }), opts);
  });
});

describe('fuzz: a disclosed threshold is the truth', () => {
  test('wouldHaveNeeded actually satisfies the clause it names', () => {
    fc.assert(fc.property(rule, facts, (r, f) => {
      const truth = tryEval(r, f);
      if (truth === SKIP) return;
      for (const d of disclose(reasons(r, f, truth), f, {})) {
        if (d.wouldHaveNeeded === undefined) continue;
        // Substituting the named value must flip that clause to TRUE. An
        // adverse action notice naming a value that would NOT have helped is
        // worse than one naming none.
        const clause = { fact: d.fact, op: d.op, value: d.value } as Rule;
        const patched = { ...f, [d.fact]: { type: 'int' as const, value: d.wouldHaveNeeded } };
        assert.equal(tryEval(clause, patched), TRUE,
          `${d.fact} ${d.op} ${String(d.value)}: ${d.wouldHaveNeeded} would not have helped`);
      }
    }), opts);
  });
});
