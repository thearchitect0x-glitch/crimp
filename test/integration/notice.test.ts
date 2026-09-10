// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-04 · The notice, from a real record: byte-identical, gated on values, translated only by hook. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { declareRuleset, commitRule } from '../../src/domain/registry.js';
import { catalogueFact } from '../../src/domain/catalogue.js';
import { startClock } from '../../src/domain/clocks.js';
import { noticeFor, LABELS_EN, type NoticeTranslator } from '../../src/domain/notice.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, countEvents, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refusal(A: Actors, tag: string): Promise<string> {
  await catalogueFact(A.operator, { fact: 'household.income', factType: 'int', class: 'plain',
    description: 'Monthly household income' });
  await declareRuleset(A.operator, { ruleset: 'medicaid' });
  await commitRule(A.operator, { ruleset: 'medicaid', ruleId: 'renewal.income', rule: RULE,
    legalAuthority: '42 CFR 435.916(b)', effectiveFrom: new Date('2026-01-01') });
  await startClock(A.agent, { aliases: person(tag), scope: 'medicaid.renewal', clock: 'application_45_day',
    startedAt: new Date(Date.now() - 5 * 864e5) }, STRENGTHS);
  await attest(A.agent, { aliases: person(tag), facts: [
    { fact: 'household.income', type: 'int', value: 3200, source: 'state_registry' } ] }, STRENGTHS);
  const out = await seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'medicaid.renewal',
    disposition: 'bind', ruleRef: { ruleset: 'medicaid', ruleId: 'renewal.income' }, claw: CLAW }, STRENGTHS);
  assert.equal(out.outcome, 'sealed');
  return out.sealId!;
}

describe('a notice from a record', () => {
  test('is byte-identical on every derivation, and carries the citation, the label, the remedy, the clock and the appeal', async () => {
    const A = await actors();
    const id = await refusal(A, 'n1');
    const one = await noticeFor(A.operator, id);
    const two = await noticeFor(A.operator, id);
    assert.equal(one.text, two.text);
    assert.equal(one.html, two.html);
    assert.equal(JSON.stringify(one.notice), JSON.stringify(two.notice));

    assert.match(one.text, /Decision: refused/);
    assert.match(one.text, /Rule applied: renewal.income/);
    assert.match(one.text, /Legal authority: 42 CFR 435.916\(b\)/);
    assert.match(one.text, /Monthly household income is more than 2000/);
    assert.match(one.text, /What would change this:/);
    assert.match(one.text, /application_45_day \(42 CFR 435.912\(c\)\(3\)\(ii\)\): running/);
    assert.match(one.text, /right to a fair hearing/);
    assert.match(one.text, /Reference: seal_/);
    assert.equal(one.readability.target, 8);
    assert.equal(typeof one.readability.grade, 'number');
    assert.equal(one.notice.valuesDisclosed, false);
    assert.equal(one.text.includes('3200'), false, 'no value without a disclosure');
  });

  test('with values it is a disclosure: gated on authority, and recorded', async () => {
    const A = await actors();
    const id = await refusal(A, 'v1');
    await assert.rejects(() => noticeFor(A.agent, id, { values: true }), (e: unknown) =>
      e instanceof ApiError && e.code === 'insufficient_authority');
    assert.equal(await countEvents(id, 'disclosed'), 0);
    const out = await noticeFor(A.operator, id, { values: true });
    // The observed value is disclosed; what would change it is the remedy
    // (cap-02), worded as a requirement — `wouldHaveNeeded` is defined only
    // for a clause that FAILED, and in a refusal the clause held.
    assert.match(out.text, /Monthly household income is more than 2000 \(recorded as 3200, source: state_registry\)/);
    assert.match(out.text, /What would change this:\n- Monthly household income is at most 2000/);
    assert.equal(out.notice.valuesDisclosed, true);
    assert.equal(await countEvents(id, 'disclosed'), 1, 'asking for the values is on the record');
  });

  test('another language needs a translator; with one, labels and appeal text are replaced and the record is not', async () => {
    const A = await actors();
    const id = await refusal(A, 't1');
    await assert.rejects(() => noticeFor(A.operator, id, { language: 'es' }), (e: unknown) =>
      e instanceof ApiError && e.code === 'language_unavailable');
    const stub: NoticeTranslator = {
      labels: async (lang) => (lang === 'es' ? { ...LABELS_EN, title: 'Aviso de decisión', why: 'Por qué',
        op: { ...LABELS_EN.op, gt: 'es mayor que' } } : null),
      appealText: async () => 'Tiene derecho a una audiencia imparcial.',
    };
    const out = await noticeFor(A.operator, id, { language: 'es', translator: stub });
    assert.match(out.text, /^Aviso de decisión/);
    assert.match(out.text, /Por qué:\n- Monthly household income es mayor que 2000/);
    assert.match(out.text, /Tiene derecho a una audiencia imparcial\./);
    assert.match(out.text, /42 CFR 435.916\(b\)/, 'a citation is not translated');
    assert.equal(out.notice.language, 'es');
  });
});
