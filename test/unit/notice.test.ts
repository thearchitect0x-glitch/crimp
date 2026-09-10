// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-04 · A notice is a pure function of the record: same record, same bytes. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveNotice, renderText, renderHtml, readingGrade, clauseText, LABELS_EN, READING_GRADE_TARGET,
} from '../../src/domain/notice.js';
import type { Proof } from '../../src/domain/record.js';
import { ApiError } from '../../src/lib/errors.js';

const proof = (over: Partial<Proof> = {}): Proof => ({
  sealId: 'seal_abc', scope: 'medicaid.renewal', disposition: 'bind', state: 'sealed',
  rule: { fact: 'household.income', op: 'gt', value: 2000 }, ruleHash: 'f'.repeat(64),
  grammarVersion: '1', sealedBy: 'agent', sealedAt: new Date('2026-09-01T12:00:00Z'), expiresAt: null,
  asOf: null, reviewFlaggedAt: null, signature: null,
  ruleRef: { ruleset: 'medicaid', ruleId: 'renewal.income', version: 'f'.repeat(64),
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null },
  remedy: { target: 'false', exhaustive: true, evaluations: 2, sets: [[{ fact: 'household.income', factType: 'int',
    constraints: [{ path: 'rule', op: 'gt', value: 2000, truth: 'false' }] }]] },
  reasons: [{ path: 'rule', fact: 'household.income', op: 'gt', value: 2000, truth: 'true', polarity: 'direct' }],
  facts: [{ fact: 'household.income', factType: 'int', valueSha256: 'a'.repeat(64), source: 'state_registry',
    admissibility: 'authority', assertedAt: new Date('2026-08-30T00:00:00Z'), attester: 'key_1' }],
  events: [], verify: { ruleHash: '', valueDigest: '', ruleRef: '', signature: '', note: '' },
  ...over,
});

describe('derivation', () => {
  test('is deterministic: the same record renders to the same bytes, and nothing in it is "now"', () => {
    const a = deriveNotice({ proof: proof() });
    const b = deriveNotice({ proof: proof() });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(renderText(a), renderText(b));
    assert.equal(renderHtml(a), renderHtml(b));
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(renderText(a).includes(today), false, 'a notice does not know what day it is');
  });

  test('says the outcome in one fixed word, cites the rule, and carries appeal rights from config', () => {
    const n = deriveNotice({ proof: proof() });
    assert.equal(n.outcome.statement, 'refused');
    assert.equal(deriveNotice({ proof: proof({ state: 'lapsed' }) }).outcome.statement, 'reversed');
    assert.equal(deriveNotice({ proof: proof({ disposition: 'permit' }) }).outcome.statement, 'granted');
    assert.equal(n.rule.legalAuthority, '42 CFR 435.916(b)');
    assert.equal(n.appeal.programme, 'Medicaid');
    assert.equal(n.appeal.days, 90);
    assert.equal(n.valuesDisclosed, false);
  });

  test('says when a ruling elsewhere put it under review, and only while it stands', () => {
    const flagged = deriveNotice({ proof: proof({ reviewFlaggedAt: new Date('2026-09-05T00:00:00Z') }) });
    assert.equal(flagged.outcome.underReview, true);
    assert.match(renderText(flagged), /Decision: refused\nThis decision is under review following a ruling/);
    const moved = deriveNotice({ proof: proof({ reviewFlaggedAt: new Date('2026-09-05T00:00:00Z'), state: 'lapsed' }) });
    assert.equal(moved.outcome.underReview, false, 'a reversed determination is not "under review"');
  });

  test('refuses a programme with no configured appeal rights rather than omitting them', () => {
    assert.throws(() => deriveNotice({ proof: proof({ scope: 'lending.card' }) }), (e: unknown) =>
      e instanceof ApiError && e.code === 'programme_not_configured');
  });

  test('uses the catalogue description as the label when one exists', () => {
    const catalogue = new Map([['household.income', { fact: 'household.income', factType: 'int' as const,
      class: 'plain' as const, guardedBy: null, guardValue: null, allowedValues: null,
      description: 'Monthly household income', declaredBy: 'operator', declaredAt: new Date() }]]);
    const n = deriveNotice({ proof: proof(), catalogue });
    assert.equal(n.reasons[0]?.label, 'Monthly household income');
    assert.match(renderText(n), /Monthly household income is more than 2000/);
  });
});

describe('rendering', () => {
  test('a clause is fixed phrases, and a negated one says so', () => {
    const L = LABELS_EN;
    assert.equal(clauseText({ label: 'income', op: 'lte', value: 5, polarity: 'direct' }, L), 'income is at most 5');
    assert.equal(clauseText({ label: 'state', op: 'in', value: ['CA', 'NV'], polarity: 'direct' }, L), 'state is one of "CA", "NV"');
    // A negated clause is said with the opposite operator, which is exact: the
    // grammar is total over a typed fact, so "not more than" IS "at most".
    assert.equal(clauseText({ label: 'flag', op: 'eq', value: true, polarity: 'negated' }, L), 'flag is not true');
    assert.equal(clauseText({ label: 'income', op: 'gt', value: 2000, polarity: 'negated' }, L), 'income is at most 2000');
  });

  test('values appear only when disclosed, and the remedy is worded as a requirement', () => {
    const bare = renderText(deriveNotice({ proof: proof() }));
    assert.equal(bare.includes('recorded as'), false);
    assert.match(bare, /What would change this:\n- household.income is at most 2000/);
    const withValues = renderText(deriveNotice({ proof: proof(), disclosed: [
      { path: 'rule', fact: 'household.income', op: 'gt', value: 2000, truth: 'true', polarity: 'direct',
        observed: 3200, source: 'state_registry', admissibility: 'authority', wouldHaveNeeded: 2000 },
    ] }));
    assert.match(withValues, /recorded as 3200, source: state_registry\) — the rule requires 2000/);
    // The remedy takes the catalogue label too.
    const catalogue = new Map([['household.income', { fact: 'household.income', factType: 'int' as const,
      class: 'plain' as const, guardedBy: null, guardValue: null, allowedValues: null,
      description: 'Monthly household income', declaredBy: 'operator', declaredAt: new Date() }]]);
    assert.match(renderText(deriveNotice({ proof: proof(), catalogue })), /What would change this:\n- Monthly household income is at most 2000/);
  });

  test('HTML escapes everything from the record', () => {
    const n = deriveNotice({ proof: proof({ rule: { fact: 'x', op: 'eq', value: '<script>' },
      reasons: [{ path: 'rule', fact: 'x', op: 'eq', value: '<script>', truth: 'true', polarity: 'direct' }] }) });
    const html = renderHtml(n);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<article class="notice" lang="en" data-seal="seal_abc">/);
  });

  test('the reading grade is reported against the target, never enforced', () => {
    const easy = readingGrade('You have the right to ask for a hearing. Ask within 90 days.');
    assert.ok(easy.grade < READING_GRADE_TARGET, `easy text graded ${easy.grade}`);
    const hard = readingGrade('Notwithstanding the aforementioned considerations, eligibility redetermination methodologies necessitate comprehensive documentation.');
    assert.ok(hard.grade > READING_GRADE_TARGET, `hard text graded ${hard.grade}`);
    assert.equal(hard.meets, false);
    assert.equal(easy.target, 8);
    // A notice that reads hard still renders.
    assert.ok(renderText(deriveNotice({ proof: proof() })).length > 0);
  });
});
