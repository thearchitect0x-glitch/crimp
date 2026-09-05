// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRule, canonicalRule, factsReferenced, thresholds, LIMITS,
  TRUE, FALSE, UNKNOWN,
  type Rule, type Facts,
} from '../../src/domain/rule.js';
import { evaluate, RuleTypeError } from '../../src/domain/evaluate.js';
import { ApiError } from '../../src/lib/errors.js';

const F = (r: Rule): Rule => r;

function rejects(rule: unknown, why: string): void {
  assert.throws(() => validateRule(rule), (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}`);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'invalid_rule');
    return true;
  }, why);
}

describe('rule validation', () => {
  test('accepts a minimal comparison', () => {
    const facts = validateRule({ fact: 'prior_refunds_90d', op: 'lt', value: 3 });
    assert.deepEqual([...facts], ['prior_refunds_90d']);
  });

  test('accepts nesting and collects every fact once', () => {
    const facts = validateRule({
      all: [
        { fact: 'carrier.delivered', op: 'eq', value: false },
        { any: [
          { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
          { not: { fact: 'carrier.delivered', op: 'eq', value: true } },
        ] },
      ],
    });
    assert.deepEqual([...facts].sort(), ['carrier.delivered', 'prior_refunds_90d']);
  });

  test('refuses an empty conjunction — vacuously true is a decision about nobody', () => {
    rejects({ all: [] }, 'empty all');
    rejects({ any: [] }, 'empty any');
  });

  test('refuses a node that is not exactly one known shape', () => {
    rejects({}, 'no keys');
    rejects({ all: [{ fact: 'a', op: 'eq', value: 1 }], any: [] }, 'two operators');
    rejects({ fact: 'a', op: 'eq' }, 'missing value');
    rejects({ fact: 'a', op: 'eq', value: 1, extra: true }, 'extra key');
    rejects('nope', 'not an object');
    rejects(null, 'null');
    rejects([{ fact: 'a', op: 'eq', value: 1 }], 'array at root');
  });

  test('refuses unusable fact names', () => {
    for (const fact of ['', 'Upper', '1leading', 'has space', 'trailing.', '.leading', 'a..b', 'a-b']) {
      rejects({ fact, op: 'eq', value: 1 }, `fact name ${JSON.stringify(fact)}`);
    }
  });

  test('accepts dotted fact names up to four segments', () => {
    validateRule({ fact: 'a.b.c.d', op: 'eq', value: 1 });
    rejects({ fact: 'a.b.c.d.e', op: 'eq', value: 1 }, 'five segments');
  });

  test('refuses unknown operators', () => {
    rejects({ fact: 'a', op: 'matches', value: 'x' }, 'regex operator');
    rejects({ fact: 'a', op: '==', value: 1 }, 'symbolic operator');
  });

  test('refuses non-integer numbers — floats make equality a lie', () => {
    rejects({ fact: 'a', op: 'eq', value: 1.5 }, 'float');
    rejects({ fact: 'a', op: 'eq', value: Number.MAX_VALUE }, 'unsafe integer');
    rejects({ fact: 'a', op: 'eq', value: NaN }, 'NaN');
    rejects({ fact: 'a', op: 'eq', value: Infinity }, 'Infinity');
  });

  test('refuses null and objects as values', () => {
    rejects({ fact: 'a', op: 'eq', value: null }, 'null value');
    rejects({ fact: 'a', op: 'eq', value: { nested: 1 } }, 'object value');
  });

  test('ordered operators require a number literal', () => {
    rejects({ fact: 'a', op: 'lt', value: 'x' }, 'lt on string');
    rejects({ fact: 'a', op: 'gte', value: true }, 'gte on bool');
    validateRule({ fact: 'a', op: 'gte', value: 0 });
  });

  test('set operators require a non-empty homogeneous array', () => {
    rejects({ fact: 'a', op: 'in', value: 'x' }, 'in with scalar');
    rejects({ fact: 'a', op: 'in', value: [] }, 'in with empty array');
    rejects({ fact: 'a', op: 'in', value: [1, 'x'] }, 'mixed types');
    rejects({ fact: 'a', op: 'eq', value: [1, 2] }, 'eq with array');
    validateRule({ fact: 'a', op: 'in', value: ['US', 'CA'] });
  });

  test('enforces the size limits', () => {
    const deep = (n: number): Rule => (n === 0
      ? { fact: 'a', op: 'eq', value: 1 }
      : { not: deep(n - 1) });
    validateRule(deep(LIMITS.maxDepth - 1));
    rejects(deep(LIMITS.maxDepth + 1), 'too deep');

    const wide = { all: Array.from({ length: LIMITS.maxNodes + 1 },
      () => ({ fact: 'a', op: 'eq', value: 1 })) };
    rejects(wide, 'too many nodes');

    rejects({ fact: 'a', op: 'in', value: Array.from({ length: LIMITS.maxSetSize + 1 }, (_, i) => i) },
      'set too large');
    rejects({ fact: 'a', op: 'eq', value: 'x'.repeat(LIMITS.maxStringLength + 1) }, 'string too long');
  });
});

describe('canonical form', () => {
  test('is order-independent for commutative operators', () => {
    const a = F({ all: [
      { fact: 'x', op: 'eq', value: 1 },
      { fact: 'y', op: 'eq', value: 2 },
    ] });
    const b = F({ all: [
      { fact: 'y', op: 'eq', value: 2 },
      { fact: 'x', op: 'eq', value: 1 },
    ] });
    assert.equal(canonicalRule(a), canonicalRule(b),
      'two agents writing the same policy in different orders must hash alike');
  });

  test('is order-independent for set members', () => {
    assert.equal(
      canonicalRule({ fact: 'c', op: 'in', value: ['US', 'CA'] }),
      canonicalRule({ fact: 'c', op: 'in', value: ['CA', 'US'] }),
    );
  });

  test('distinguishes rules that differ in meaning', () => {
    const lt = canonicalRule({ fact: 'n', op: 'lt', value: 3 });
    assert.notEqual(lt, canonicalRule({ fact: 'n', op: 'lte', value: 3 }));
    assert.notEqual(lt, canonicalRule({ fact: 'n', op: 'lt', value: 4 }));
    assert.notEqual(lt, canonicalRule({ fact: 'm', op: 'lt', value: 3 }));
    assert.notEqual(
      canonicalRule({ all: [{ fact: 'a', op: 'eq', value: 1 }, { fact: 'b', op: 'eq', value: 1 }] }),
      canonicalRule({ any: [{ fact: 'a', op: 'eq', value: 1 }, { fact: 'b', op: 'eq', value: 1 }] }),
    );
  });

  test('does not mutate the rule as written', () => {
    const rule = F({ all: [
      { fact: 'z', op: 'eq', value: 1 },
      { fact: 'a', op: 'eq', value: 2 },
    ] });
    const before = JSON.stringify(rule);
    canonicalRule(rule);
    assert.equal(JSON.stringify(rule), before, 'the examiner is shown what was written');
  });
});

describe('evaluation — three-valued', () => {
  const facts: Facts = {
    'carrier.delivered': { type: 'bool', value: true },
    'prior_refunds_90d': { type: 'int', value: 2 },
    country: { type: 'str', value: 'US' },
    opened_at: { type: 'time', value: 1_700_000_000_000 },
  };

  test('compares each type correctly', () => {
    assert.equal(evaluate({ fact: 'carrier.delivered', op: 'eq', value: true }, facts), TRUE);
    assert.equal(evaluate({ fact: 'carrier.delivered', op: 'ne', value: true }, facts), FALSE);
    assert.equal(evaluate({ fact: 'prior_refunds_90d', op: 'lt', value: 3 }, facts), TRUE);
    assert.equal(evaluate({ fact: 'prior_refunds_90d', op: 'gte', value: 3 }, facts), FALSE);
    assert.equal(evaluate({ fact: 'country', op: 'in', value: ['US', 'CA'] }, facts), TRUE);
    assert.equal(evaluate({ fact: 'country', op: 'nin', value: ['US'] }, facts), FALSE);
    assert.equal(evaluate({ fact: 'opened_at', op: 'lt', value: 1_800_000_000_000 }, facts), TRUE);
  });

  test('an unattested fact is UNKNOWN, never false', () => {
    assert.equal(evaluate({ fact: 'never_attested', op: 'eq', value: 1 }, facts), UNKNOWN);
    assert.equal(evaluate({ not: { fact: 'never_attested', op: 'eq', value: 1 } }, facts), UNKNOWN,
      'negating an unknown does not manufacture knowledge');
  });

  test('Kleene conjunction: one FALSE decides, otherwise UNKNOWN withholds', () => {
    const known = F({ fact: 'prior_refunds_90d', op: 'lt', value: 3 });   // TRUE
    const no    = F({ fact: 'prior_refunds_90d', op: 'gt', value: 9 });   // FALSE
    const dunno = F({ fact: 'missing', op: 'eq', value: 1 });             // UNKNOWN
    assert.equal(evaluate({ all: [known, dunno] }, facts), UNKNOWN);
    assert.equal(evaluate({ all: [no, dunno] }, facts), FALSE, 'a known FALSE settles it');
    assert.equal(evaluate({ all: [known, known] }, facts), TRUE);
  });

  test('Kleene disjunction: one TRUE decides, otherwise UNKNOWN withholds', () => {
    const known = F({ fact: 'prior_refunds_90d', op: 'lt', value: 3 });   // TRUE
    const no    = F({ fact: 'prior_refunds_90d', op: 'gt', value: 9 });   // FALSE
    const dunno = F({ fact: 'missing', op: 'eq', value: 1 });             // UNKNOWN
    assert.equal(evaluate({ any: [known, dunno] }, facts), TRUE, 'a known TRUE settles it');
    assert.equal(evaluate({ any: [no, dunno] }, facts), UNKNOWN);
    assert.equal(evaluate({ any: [no, no] }, facts), FALSE);
  });

  test('negation is an involution on the two known values', () => {
    const t = F({ fact: 'carrier.delivered', op: 'eq', value: true });
    assert.equal(evaluate({ not: t }, facts), FALSE);
    assert.equal(evaluate({ not: { not: t } }, facts), TRUE);
  });

  test('normalises Unicode on both sides, so one string is one string', () => {
    const nfd: Facts = { city: { type: 'str', value: 'café' } };
    assert.equal(evaluate({ fact: 'city', op: 'eq', value: 'café' }, nfd), TRUE);
    assert.equal(evaluate({ fact: 'city', op: 'in', value: ['café'] }, nfd), TRUE);
  });

  test('a type mismatch is a caller bug, thrown — not absorbed as UNKNOWN', () => {
    for (const rule of [
      F({ fact: 'country', op: 'lt', value: 3 }),
      F({ fact: 'prior_refunds_90d', op: 'eq', value: 'two' }),
      F({ fact: 'carrier.delivered', op: 'eq', value: 1 }),
      F({ fact: 'carrier.delivered', op: 'in', value: [1, 2] }),
      F({ fact: 'country', op: 'in', value: [1, 2] }),
    ]) {
      assert.throws(() => evaluate(rule, facts), (e: unknown) => {
        assert.ok(e instanceof RuleTypeError);
        assert.equal((e as RuleTypeError).status, 400);
        assert.equal((e as RuleTypeError).code, 'rule_type_mismatch');
        return true;
      }, JSON.stringify(rule));
    }
  });

  test('evaluation is pure: the same inputs give the same answer', () => {
    const rule = F({ all: [
      { fact: 'carrier.delivered', op: 'eq', value: true },
      { any: [{ fact: 'prior_refunds_90d', op: 'lt', value: 3 }, { fact: 'country', op: 'eq', value: 'CA' }] },
    ] });
    const first = evaluate(rule, facts);
    for (let i = 0; i < 50; i++) assert.equal(evaluate(rule, facts), first);
  });
});

describe('introspection', () => {
  const rule = F({ all: [
    { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
    { any: [
      { fact: 'order.total_micros', op: 'gte', value: 50_000_000 },
      { fact: 'country', op: 'in', value: ['US'] },
    ] },
    { not: { fact: 'chargeback_filed', op: 'eq', value: true } },
  ] });

  test('lists every fact the rule reads', () => {
    assert.deepEqual([...factsReferenced(rule)].sort(),
      ['chargeback_filed', 'country', 'order.total_micros', 'prior_refunds_90d']);
  });

  test('extracts every ordered boundary, which is what the cliff analysis counts', () => {
    assert.deepEqual(thresholds(rule).sort((a, b) => a.fact.localeCompare(b.fact)), [
      { fact: 'order.total_micros', op: 'gte', value: 50_000_000 },
      { fact: 'prior_refunds_90d', op: 'lt', value: 3 },
    ]);
  });

  test('a rule with no ordered comparison draws no cliffs', () => {
    assert.deepEqual(thresholds({ fact: 'country', op: 'in', value: ['US'] }), []);
  });
});
