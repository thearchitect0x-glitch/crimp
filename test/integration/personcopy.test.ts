// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** Phase 2 · One person's copy: only theirs, with values, recorded as a disclosure, and self-verifying. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { startClock } from '../../src/domain/clocks.js';
import { personCopy } from '../../src/domain/personcopy.js';
import { proofToWire } from '../../src/api/serialize.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, person, countEvents, STRENGTHS } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };

before(async () => {
  process.env['SIGNING_KEY'] ||= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  await migrate(() => {});
});
after(async () => { await closePool(); });

describe('a person\'s copy', () => {
  test('holds their facts with values, their determinations, their clocks, the keys and the verifier — and nobody else\'s', async () => {
    const A = await actors();
    for (const [tag, income] of [['me', 3000], ['someone_else', 3000]] as const) {
      await attest(A.agent, { aliases: person(tag), facts: [
        { fact: 'household.income', type: 'int', value: income, source: 'state_registry' } ] }, STRENGTHS);
      await seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'medicaid.renewal',
        disposition: 'bind', rule: { fact: 'household.income', op: 'gt', value: 2000 }, claw: CLAW }, STRENGTHS);
    }
    await seal(A.agent, { idempotencyKey: 'idem-me-2', aliases: person('me'), scope: 'snap.certification',
      disposition: 'permit', rule: { fact: 'household.income', op: 'gt', value: 2000 }, claw: CLAW }, STRENGTHS);
    await startClock(A.agent, { aliases: person('me'), scope: 'medicaid.renewal', clock: 'application_45_day',
      startedAt: new Date(Date.now() - 864e5) }, STRENGTHS);

    const copy = await personCopy(A.operator, { aliases: person('me') }, STRENGTHS);
    assert.equal(copy.format, 'crimp-person-copy/1');
    assert.deepEqual(copy.facts.map((f) => [f.fact, f.value]), [['household.income', 3000]]);
    assert.equal(copy.determinations.length, 2, 'both of mine, none of theirs');
    assert.ok(copy.determinations.every((d) => d.signature !== null));
    assert.equal(copy.clocks.length, 1);
    assert.equal(copy.keys.length, 1);
    assert.match(copy.verify.verifier_source, /export async function verify/);
    assert.deepEqual(copy.verify.held_values, { 'household.income': { type: 'int', value: 3000 } });
    assert.equal(JSON.stringify(copy).includes('someone_else'), false);

    // Recorded as a disclosure on each determination it contains.
    for (const d of copy.determinations) assert.equal(await countEvents(d.sealId, 'disclosed'), 1);

    // Self-verifying: the copy's own verifier, values and keys check the copy's own records.
    const dir = mkdtempSync(join(tmpdir(), 'crimp-copy-'));
    writeFileSync(join(dir, 'verifier.mjs'), copy.verify.verifier_source);
    type Step = { step: string; ok: boolean | null; detail: string };
    const mod = await import(join(dir, 'verifier.mjs')) as {
      verify: (det: unknown, held: unknown, opts: unknown) => Promise<{ steps: Step[]; ok: boolean }> };
    for (const d of copy.determinations) {
      const { steps, ok } = await mod.verify(proofToWire(d), copy.verify.held_values, { keys: copy.keys });
      assert.equal(ok, true, JSON.stringify(steps));
      assert.equal(steps.find((s: { step: string }) => s.step === 'signature')?.ok, true);
      assert.equal(steps.find((s: { step: string }) => s.step === 're-evaluation')?.ok, true);
    }
  });

  test('is issued only against identity-grade identifiers, never resolves through a shared one, and attaches nothing', async () => {
    const A = await actors();
    await attest(A.agent, { aliases: person('owner'), facts: [
      { fact: 'household.income', type: 'int', value: 3000, source: 'state_registry' } ] }, STRENGTHS);
    // A phone alone (medium) cannot say whose copy this is.
    await assert.rejects(() => personCopy(A.operator, { aliases: [{ type: 'email', value: 'owner@example.com' }] }, STRENGTHS),
      (e: unknown) => e instanceof ApiError && e.code === 'identity_required');
    // A stranger's own card beside the owner's shared email: not the owner's data.
    await assert.rejects(() => personCopy(A.operator, { aliases: [
      { type: 'card_fp', value: 'card-stranger' }, { type: 'email', value: 'owner@example.com' } ] }, STRENGTHS),
    (e: unknown) => e instanceof ApiError && e.code === 'unknown_subject');
    // And the stranger's card was not bound to the owner by asking.
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM subject_aliases WHERE workspace_id = $1', [A.ws]);
    assert.equal(Number(rows[0]?.n), 2, 'owner\'s two aliases, nothing else');
  });

  test('is an operator\'s act, and only for a person the system knows', async () => {
    const A = await actors();
    await assert.rejects(() => personCopy(A.agent, { aliases: person('x') }, STRENGTHS), (e: unknown) =>
      e instanceof ApiError && e.code === 'insufficient_authority');
    await assert.rejects(() => personCopy(A.operator, { aliases: person('nobody') }, STRENGTHS), (e: unknown) =>
      e instanceof ApiError && e.code === 'unknown_subject');
  });
});
