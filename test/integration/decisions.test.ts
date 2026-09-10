// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-10 · A person decides the way an agent does: a committed rule, attached
 * facts, and whatever the evaluator says. No outcome field exists to fill.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { seal } from '../../src/domain/seal.js';
import { decide } from '../../src/domain/decisions.js';
import { declareRuleset, commitRule } from '../../src/domain/registry.js';
import { proof } from '../../src/domain/record.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const RULE = { fact: 'household.income', op: 'gt', value: 2000 };
const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<ApiError> {
  let caught: ApiError | undefined;
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why); caught = e; return true;
  }, why);
  return caught!;
}
async function programme(A: Actors): Promise<void> {
  await declareRuleset(A.operator, { ruleset: 'medicaid' });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.income', rule: RULE, disposition: 'bind',
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.open', rule: RULE,
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
}
const income = (value: number) => [{ fact: 'household.income', type: 'int' as const, value, source: 'state_registry' }];

describe('a caseworker\'s decision', () => {
  test('is a committed rule plus facts; the facts carry the caseworker as attester; the kind is the rule\'s', async () => {
    const A = await actors();
    await programme(A);
    const out = await decide(A.operator, { idempotencyKey: 'dec-1', aliases: person('c1'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', ruleId: 'renewal.income', facts: income(3000) }, STRENGTHS);
    assert.equal(out.outcome, 'sealed');
    assert.equal(out.disposition, 'bind');
    assert.equal(out.attested, 1);
    assert.equal(out.attester, A.operator.keyId);
    assert.equal(out.ruleRef?.ruleId, 'renewal.income');
    const rec = await proof(A.operator, out.sealId!);
    assert.equal(rec.facts[0]?.attester, A.operator.keyId);
    assert.equal(rec.sealedBy, 'operator');
    const { rows } = await getPool().query<{ attester: string }>(
      `SELECT attester FROM attestations WHERE workspace_id = $1 AND fact = 'household.income'`, [A.ws]);
    assert.equal(rows[0]?.attester, A.operator.keyId);
  });

  test('the evaluator still decides: facts that do not satisfy the rule make no determination', async () => {
    const A = await actors();
    await programme(A);
    const out = await decide(A.operator, { idempotencyKey: 'dec-2', aliases: person('c2'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', ruleId: 'renewal.income', facts: income(100) }, STRENGTHS);
    assert.equal(out.outcome, 'not_applicable');
    assert.equal(out.sealId, null);
  });

  test('is a person\'s act', async () => {
    const A = await actors();
    await programme(A);
    await refuses(() => decide(A.agent, { idempotencyKey: 'dec-3', aliases: person('c3'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', ruleId: 'renewal.income', facts: income(3000) }, STRENGTHS),
    'insufficient_authority', 'an agent on the human path');
  });

  test('needs a rule that says what kind of determination it makes', async () => {
    const A = await actors();
    await programme(A);
    await refuses(() => decide(A.operator, { idempotencyKey: 'dec-4', aliases: person('c4'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', ruleId: 'renewal.open', facts: income(3000) }, STRENGTHS),
    'rule_has_no_disposition', 'a rule with no disposition');
    await refuses(() => decide(A.operator, { idempotencyKey: 'dec-5', aliases: person('c5'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', ruleId: 'renewal.nope', facts: income(3000) }, STRENGTHS),
    'unknown_rule', 'a rule that was never committed');
  });

  test('a fact without a declared source is refused, on the human path as on the agent path', async () => {
    const A = await actors();
    await programme(A);
    await refuses(() => decide(A.operator, { idempotencyKey: 'dec-6', aliases: person('c6'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', ruleId: 'renewal.income',
      facts: [{ fact: 'household.income', type: 'int', value: 3000, source: 'my_memory' }] }, STRENGTHS),
    'unknown_source', 'an undeclared source');
  });

  test('a rule\'s disposition binds every seal made under it, agent or person', async () => {
    const A = await actors();
    await programme(A);
    await decide(A.operator, { idempotencyKey: 'dec-7', aliases: person('c7'), scope: 'medicaid.renewal',
      ruleset: 'medicaid', ruleId: 'renewal.income', facts: income(3000) }, STRENGTHS);
    await refuses(() => seal(A.agent, { idempotencyKey: 'idem-c7', aliases: person('c7'), scope: 'medicaid.renewal',
      disposition: 'permit', ruleRef: { ruleset: 'medicaid', ruleId: 'renewal.income' }, claw: CLAW }, STRENGTHS),
    'disposition_fixed_by_rule', 'an agent sealing a refusal rule as a grant');
    const ok = await seal(A.agent, { idempotencyKey: 'idem-c7b', aliases: person('c7'), scope: 'medicaid.renewal',
      disposition: 'bind', ruleRef: { ruleset: 'medicaid', ruleId: 'renewal.income' }, claw: CLAW }, STRENGTHS);
    assert.equal(ok.outcome, 'sealed');
  });
});
