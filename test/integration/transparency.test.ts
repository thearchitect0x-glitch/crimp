// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The transparency anchor: a record's date, provable without its issuer's key.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal } from '../../src/domain/seal.js';
import { proof } from '../../src/domain/record.js';
import { closeDays, inclusionOf, publishedRoots, anchorRoot } from '../../src/domain/transparency.js';
import { root as merkleRoot } from '../../src/lib/merkle.js';
import { sweepOnce } from '../../src/worker/sweep.js';
import { actors, person, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'household.income', op: 'gt', value: 2000 };
const VERIFIER = '../../spec/verifier.mjs';

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refusal(A: Actors, tag: string): Promise<string> {
  await attest(A.agent, { aliases: person(tag), facts: [{ fact: 'household.income', type: 'int', value: 3000, source: 'core_ledger' }] }, STRENGTHS);
  const s = await seal(A.agent, { idempotencyKey: `idem-${tag}`, aliases: person(tag), scope: 'medicaid.renewal', disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
  return s.sealId!;
}
/** Tomorrow, UTC: closing before it closes today. Nothing about any record is touched. */
const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

describe('the transparency anchor', () => {
  test('every sealed core has a digest, closed days get roots, and an inclusion proof walks to the published global root', async () => {
    const A = await actors(); const B = await actors();
    const a = [await refusal(A, 'a1'), await refusal(A, 'a2'), await refusal(A, 'a3')];
    const b = [await refusal(B, 'b1')];
    const { rows: d } = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM seals WHERE id = ANY($1::text[]) AND core_sha256 IS NOT NULL`, [[...a, ...b]]);
    assert.equal(Number(d[0]!.n), 4, 'a digest on every core, signed or not');

    // This test closes TODAY. A previous run in the same database on the same
    // day may have anchored it; an anchored day cannot be recomputed. Put the
    // day back before starting, as well as after.
    await getPool().query(`UPDATE transparency_global_roots SET anchor = NULL WHERE day = timezone('UTC', now())::date`);
    // The worker's own pass closes only days strictly before today: nothing yet.
    const pass = await sweepOnce();
    assert.equal(await inclusionOf(getPool(), A.ws, a[0]!), null, 'today has not closed');
    void pass;
    // Close today, as tomorrow's pass would.
    const closed = await closeDays(getPool(), { closeBefore: tomorrow() });
    assert.ok(closed.workspaceDays >= 2, `both tenants' days closed: ${JSON.stringify(closed)}`);
    assert.ok(closed.globalDays >= 1);

    const inc = (await inclusionOf(getPool(), A.ws, a[1]!))!;
    assert.equal(inc.workspace.leaf_count, 3);
    assert.equal(inc.workspace.index, 1);
    assert.ok(inc.global !== null && inc.global.workspaces >= 2, 'the global tree covers both tenants');

    // The verifier, holding the record, its proof and the published roots, walks the whole way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { verify } = (await import(VERIFIER)) as any;
    const rec = await proof(A.operator, a[1]!);
    const { proofToWire } = await import('../../src/api/serialize.js');
    const det = { ...proofToWire(rec), inclusion: inc };
    const roots = await publishedRoots(getPool());
    const r = await verify(det, {}, { roots });
    const step = r.steps.find((s: { step: string }) => s.step === 'inclusion');
    assert.equal(step?.ok, true, step?.detail);
    assert.match(step?.detail, /not yet anchored/);

    // Anchored: the operator records what the world saw.
    assert.equal(await anchorRoot(getPool(), inc.day, { kind: 'opentimestamps', ots_base64: 'AAAA', calendar: 'https://a.pool.opentimestamps.org' }), true);
    assert.equal(await anchorRoot(getPool(), inc.day, { kind: 'other' }), false, 'an anchor is never replaced');
    const r2 = await verify(det, {}, { roots: await publishedRoots(getPool()) });
    assert.match(r2.steps.find((s: { step: string }) => s.step === 'inclusion')?.detail, /\(anchored\)/);

    // Tampering with the core breaks the leaf; a wrong published root is caught.
    const bad = await verify({ ...det, scope: 'elsewhere' }, {}, { roots });
    assert.equal(bad.steps.find((s: { step: string }) => s.step === 'inclusion')?.ok, false);
    const wrongRoots = roots.map((x) => ({ ...x, root: 'f'.repeat(64) }));
    const wr = await verify(det, {}, { roots: wrongRoots });
    assert.equal(wr.steps.find((s: { step: string }) => s.step === 'inclusion')?.ok, false);
    // Without a published list the walk still checks itself.
    const alone = await verify(det, {}, {});
    assert.equal(alone.steps.find((s: { step: string }) => s.step === 'inclusion')?.ok, null);

    // A second pass changes nothing: roots are final.
    const before = await publishedRoots(getPool());
    await closeDays(getPool(), { closeBefore: tomorrow() });
    assert.deepEqual(await publishedRoots(getPool()), before);
    // And the workspace root is what the leaves say it is.
    const { rows: leaves } = await getPool().query<{ core_sha256: string }>(
      `SELECT core_sha256 FROM seals WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY sealed_at, id`, [A.ws, a]);
    assert.equal(inc.workspace.root, merkleRoot(leaves.map((l) => l.core_sha256)));

    // A workspace whose day closes AFTER the global root was anchored reaches
    // its workspace root and no further — and the proof says exactly that.
    const C = await actors();
    const late = await refusal(C, 'c1');
    await closeDays(getPool(), { closeBefore: tomorrow() });
    const lateInc = (await inclusionOf(getPool(), C.ws, late))!;
    assert.equal(lateInc.global, null);
    assert.match(lateInc.note!, /anchored before this workspace's day closed/);
    const lateRec = await proof(C.operator, late);
    const lr = await verify({ ...proofToWire(lateRec), inclusion: lateInc }, {}, { roots: await publishedRoots(getPool()) });
    const ls = lr.steps.find((s: { step: string }) => s.step === 'inclusion');
    assert.equal(ls?.ok, null);
    assert.match(ls?.detail, /anchored before/);

    // This test closes TODAY and anchors it, which a second run in the same
    // database on the same day would otherwise inherit. Put the day back.
    await getPool().query('UPDATE transparency_global_roots SET anchor = NULL WHERE day = $1::date', [inc.day]);
  });
});
