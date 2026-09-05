// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateScope, covers, ancestors, ALL } from '../../src/domain/scope.js';
import {
  ADMISSIBILITY, dominates, meetsFloor, closurePairs, isSelfAsserted,
  type Admissibility,
} from '../../src/domain/admissibility.js';
import {
  validateClawRule, assertTightening, mayClaw, AUTHORITIES,
  MAX_COOLING_OFF_SECONDS, type Authority, type ClawRule,
} from '../../src/domain/authority.js';
import { classify, tierOf, harden } from '../../src/domain/lifecycle.js';
import { TRUE, FALSE, UNKNOWN } from '../../src/domain/rule.js';
import { ApiError } from '../../src/lib/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const claw = (o: Partial<ClawRule> = {}): ClawRule => ({
  authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0, ...o,
});

function refuses(fn: () => unknown, code: string, why: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  }, why);
}

describe('scope', () => {
  test('a broader scope covers a narrower one', () => {
    assert.equal(covers('refund', 'refund.issue.goodwill'), true);
    assert.equal(covers('refund.issue', 'refund.issue.goodwill'), true);
    assert.equal(covers(ALL, 'anything.at.all'), true);
    assert.equal(covers('refund', 'refund'), true);
  });

  test('containment runs one way only', () => {
    assert.equal(covers('refund.issue', 'refund'), false,
      'refusing one way of refunding is not refusing all of them');
    assert.equal(covers('refund.issue', 'refund.reverse'), false);
  });

  test('a shared prefix that is not a segment boundary does not count', () => {
    assert.equal(covers('refund', 'refunding'), false,
      'string prefix is not scope containment');
    assert.equal(covers('re', 'refund'), false);
  });

  test('ancestors are bounded and include the universal scope', () => {
    assert.deepEqual(ancestors('a.b.c'), [ALL, 'a', 'a.b', 'a.b.c']);
    assert.deepEqual(ancestors(ALL), [ALL]);
    assert.ok(ancestors('a.b.c.d').length <= 5, 'the hot-path lookup stays a small ANY()');
  });

  test('every ancestor covers the query, and nothing else does', () => {
    const q = 'refund.issue.goodwill';
    for (const a of ancestors(q)) assert.equal(covers(a, q), true, `${a} should cover ${q}`);
    assert.equal(covers('refund.issue.goodwill.extra', q), false);
  });

  test('validation refuses unusable scopes', () => {
    for (const s of ['', 'Upper', '1x', 'a..b', 'a.', '.a', 'a b', 'a.b.c.d.e']) {
      refuses(() => validateScope(s), 'invalid_scope', JSON.stringify(s));
    }
    refuses(() => validateScope(null), 'invalid_scope', 'null');
    assert.equal(validateScope('refund.issue'), 'refund.issue');
    assert.equal(validateScope(ALL), ALL);
  });
});

describe('admissibility', () => {
  test('is reflexive — a class satisfies its own floor', () => {
    for (const c of ADMISSIBILITY) assert.equal(dominates(c, c), true, c);
  });

  test('is transitive', () => {
    assert.equal(dominates('authority', 'self'), true, 'authority ⊒ receipt ⊒ internal ⊒ signed ⊒ self');
    assert.equal(dominates('receipt', 'self'), true);
  });

  test('internal and witness are deliberately incomparable', () => {
    assert.equal(dominates('internal', 'witness'), false);
    assert.equal(dominates('witness', 'internal'), false,
      'an operator ledger and an outside observer are wrong in different directions');
  });

  test('an agent cannot talk its way past a disinterested floor', () => {
    for (const own of ['self', 'signed'] as Admissibility[]) {
      assert.equal(meetsFloor(own, 'receipt'), false,
        `${own} must never satisfy a receipt floor — signing proves non-repudiation, not truth`);
      assert.equal(meetsFloor(own, 'authority'), false);
      assert.equal(isSelfAsserted(own), true);
    }
  });

  test('the order is antisymmetric — no two distinct classes dominate each other', () => {
    for (const a of ADMISSIBILITY) {
      for (const b of ADMISSIBILITY) {
        if (a !== b && dominates(a, b)) {
          assert.equal(dominates(b, a), false, `${a} and ${b} dominate each other — that is a cycle`);
        }
      }
    }
  });

  test('the code order and migration 001 agree, so they cannot drift', () => {
    const sql = readFileSync(join(here, '../../src/db/migrations/001_init.sql'), 'utf8');
    const fromSql = new Set<string>();
    // Reflexive rows are inserted by SELECT, not VALUES; add them to match.
    for (const c of ADMISSIBILITY) fromSql.add(`${c}|${c}`);
    for (const m of sql.matchAll(/\('([a-z]+)',\s*'([a-z]+)'\)/g)) {
      const higher = m[1] as string; const lower = m[2] as string;
      if ((ADMISSIBILITY as readonly string[]).includes(higher)
        && (ADMISSIBILITY as readonly string[]).includes(lower)) {
        fromSql.add(`${higher}|${lower}`);
      }
    }
    const fromCode = new Set(closurePairs().map(([h, l]) => `${h}|${l}`));
    assert.deepEqual([...fromCode].sort(), [...fromSql].sort(),
      'src/domain/admissibility.ts and migration 001 must express the same partial order');
  });
});

describe('claw rules', () => {
  test('the reversing authority must strictly exceed the sealer', () => {
    for (const level of AUTHORITIES) {
      refuses(() => validateClawRule(level, claw({ authority: level })),
        'invalid_claw_rule', `${level} reversing itself`);
    }
    refuses(() => validateClawRule('operator', claw({ authority: 'agent' })),
      'invalid_claw_rule', 'downward reversal');
  });

  test('an agent may seal a refusal it can never lift', () => {
    const rule = validateClawRule('agent', claw({ authority: 'operator' }));
    assert.equal(rule.authority, 'operator');
    assert.equal(mayClaw('agent', 'operator'), false, 'the sentence the product is sold on');
    assert.equal(mayClaw('operator', 'operator'), true);
    assert.equal(mayClaw('custodian', 'operator'), true);
  });

  test('an agent cannot put a seal beyond an operator — the blast-radius cap', () => {
    for (const beyond of ['principal', 'custodian'] as Authority[]) {
      refuses(() => validateClawRule('agent', claw({ authority: beyond })),
        'invalid_claw_rule',
        `agent requiring ${beyond} would let one compromised agent brick the workspace`);
    }
  });

  test('a human authority is not capped — that is a deliberate, accountable choice', () => {
    validateClawRule('operator', claw({ authority: 'custodian' }));
    validateClawRule('principal', claw({ authority: 'custodian' }));
  });

  test('refuses malformed rules', () => {
    refuses(() => validateClawRule('agent', claw({ authority: 'root' as Authority })),
      'invalid_claw_rule', 'unknown authority');
    refuses(() => validateClawRule('agent', claw({ evidenceFloor: 'vibes' as Admissibility })),
      'invalid_claw_rule', 'unknown evidence class');
    refuses(() => validateClawRule('agent', claw({ coolingOffSeconds: -1 })),
      'invalid_claw_rule', 'negative cooling-off');
    refuses(() => validateClawRule('agent', claw({ coolingOffSeconds: 1.5 })),
      'invalid_claw_rule', 'fractional cooling-off');
    refuses(() => validateClawRule('agent', claw({ coolingOffSeconds: MAX_COOLING_OFF_SECONDS + 1 })),
      'invalid_claw_rule', 'cooling-off beyond the ceiling');
  });
});

describe('tighten and never loosen', () => {
  const from = claw({ authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 3600 });

  test('permits tightening on every dimension', () => {
    assertTightening(from, { ...from });
    assertTightening(from, { ...from, authority: 'principal' });
    assertTightening(from, { ...from, evidenceFloor: 'receipt' });
    assertTightening(from, { ...from, coolingOffSeconds: 7200 });
  });

  test('refuses loosening on every dimension', () => {
    refuses(() => assertTightening(from, { ...from, authority: 'agent' }),
      'claw_rule_loosened', 'lower authority');
    refuses(() => assertTightening(from, { ...from, evidenceFloor: 'self' }),
      'claw_rule_loosened', 'weaker evidence');
    refuses(() => assertTightening(from, { ...from, coolingOffSeconds: 0 }),
      'claw_rule_loosened', 'shorter delay');
  });

  test('refuses a sideways move to an incomparable evidence class', () => {
    refuses(() => assertTightening(from, { ...from, evidenceFloor: 'witness' }),
      'claw_rule_loosened',
      'witness does not dominate internal, so the move admits evidence the old floor excluded');
  });

  test('names what was loosened, so an operator can see why', () => {
    assert.throws(() => assertTightening(from, { authority: 'agent', evidenceFloor: 'self', coolingOffSeconds: 0 }),
      (e: unknown) => {
        const detail = (e as ApiError).detail as { loosened: string[] };
        assert.equal(detail.loosened.length, 3);
        return true;
      });
  });
});

describe('re-evaluation', () => {
  test('the third truth value is the whole lifecycle', () => {
    assert.equal(classify(TRUE), 'sealed');
    assert.equal(classify(FALSE), 'lapsed');
    assert.equal(classify(UNKNOWN), 'tainted');
  });

  test('an unknown never lifts a seal', () => {
    assert.notEqual(classify(UNKNOWN), 'lapsed',
      'lifting on an unknown is guessing, and guessing is what a gate must not do');
  });
});

describe('pressure hardening', () => {
  const base = claw({ authority: 'operator', evidenceFloor: 'internal' });

  test('tiers separate persistence from probing', () => {
    assert.equal(tierOf({ attempts: 0, sessions: 0 }), 'none');
    assert.equal(tierOf({ attempts: 2, sessions: 1 }), 'none', 'asking twice is not an attack');
    assert.equal(tierOf({ attempts: 5, sessions: 1 }), 'persistent');
    assert.equal(tierOf({ attempts: 12, sessions: 3 }), 'probing');
    assert.equal(tierOf({ attempts: 40, sessions: 8 }), 'sustained');
  });

  test('many attempts from a single session is persistence, not probing', () => {
    assert.equal(tierOf({ attempts: 50, sessions: 1 }), 'persistent',
      'one determined person is not a distributed probe');
  });

  test('persistence alone changes nothing', () => {
    const { rule, hardened } = harden('bind', base, 'persistent');
    assert.equal(hardened, false);
    assert.deepEqual(rule, base, 'punishing someone for caring about the outcome is not the goal');
  });

  test('probing raises authority and demands disinterested evidence', () => {
    const { rule, hardened } = harden('bind', base, 'probing');
    assert.equal(hardened, true);
    assert.equal(rule.authority, 'principal');
    assert.equal(rule.evidenceFloor, 'receipt');
    assert.equal(meetsFloor('signed', rule.evidenceFloor), false,
      'the attacker cannot supply its own grounds for release');
  });

  test('SAFETY VALVE: only a bind ever hardens', () => {
    for (const d of ['permit', 'commit'] as const) {
      for (const tier of ['persistent', 'probing', 'sustained'] as const) {
        const { rule, hardened } = harden(d, base, tier);
        assert.equal(hardened, false, `${d} hardened at ${tier} — that is a lock anyone can throw`);
        assert.deepEqual(rule, base);
      }
    }
  });

  test('SAFETY VALVE: hardening can never exceed the top authority', () => {
    const top = claw({ authority: 'custodian', evidenceFloor: 'authority' });
    for (const tier of ['probing', 'sustained'] as const) {
      const { rule } = harden('bind', top, tier);
      assert.equal(rule.authority, 'custodian',
        'a determination no human can reach is an outage, not a safety feature');
    }
  });

  test('hardening is itself a tightening, so it can never loosen a rule', () => {
    for (const tier of ['persistent', 'probing', 'sustained'] as const) {
      const { rule } = harden('bind', base, tier);
      assertTightening(base, rule);
    }
  });
});
