// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The most dangerous operation in the system, and its only correction.
 *
 * A merge is monotone and therefore permanent. Most of what follows is not
 * testing that a merge works — that is four assertions — but that the four
 * bounds hold against somebody trying to get past them. The poisoning merge is
 * the attack the whole subject graph is shaped around: present your own
 * identifier alongside a widely-shared one, force the union, and drag
 * strangers under somebody else's refusal.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { attest } from '../../src/domain/attest.js';
import { seal, lookup } from '../../src/domain/seal.js';
import { declareCohort, placeInCohort } from '../../src/domain/cohort.js';
import { mergeSubjects, carveOut } from '../../src/domain/merge.js';
import { MAX_SUBJECTS_PER_MERGE } from '../../src/lib/blind.js';
import { ApiError } from '../../src/lib/errors.js';
import { actors, countEvents, hash64, STRENGTHS, type Actors } from '../helpers.js';
import type { ClawRule } from '../../src/domain/authority.js';

const CLAW: ClawRule = { authority: 'operator', evidenceFloor: 'internal', coolingOffSeconds: 0 };
const RULE = { fact: 'carrier.delivered', op: 'eq', value: false };
const EV = { evidenceSha256: hash64('merge'), evidenceClass: 'internal' };

before(async () => { await migrate(() => {}); });
after(async () => { await closePool(); });

async function refuses(fn: () => Promise<unknown>, code: string, why: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.code, code, why);
    return true;
  }, why);
}

const card = (v: string) => ({ type: 'card_fp', value: v });
const gov = (v: string) => ({ type: 'gov_id', value: v });
const mail = (v: string) => ({ type: 'email', value: `${v}@example.com` });
const dev = (v: string) => ({ type: 'device', value: v });

/** Create a subject carrying one attested fact, identified by these aliases. */
async function subject(
  A: Actors, aliases: object[], opts: { delivered?: boolean; at?: Date } = {},
): Promise<string> {
  const out = await attest(A.agent, { aliases, facts: [
    { fact: 'carrier.delivered', type: 'bool', value: opts.delivered ?? false,
      source: 'carrier_api', ...(opts.at ? { assertedAt: opts.at } : {}) },
  ] }, STRENGTHS);
  return out.subjectId;
}

const countSubjects = async (ws: string): Promise<number> => {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*) AS n FROM subjects WHERE workspace_id = $1', [ws]);
  return Number(rows[0]!.n);
};

const subjectEvents = async (ws: string, kind: string): Promise<number> => {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*) AS n FROM subject_events WHERE workspace_id = $1 AND kind = $2', [ws, kind]);
  return Number(rows[0]!.n);
};

/* ── The dead end this exists to close ───────────────────────────────── */

describe('the hot path had no way out', () => {
  test('check still refuses to guess, but now names the way through', async () => {
    const A = await actors();
    await subject(A, [card('h1')]);
    await subject(A, [gov('h2')]);
    await assert.rejects(
      () => lookup(A.agent, { aliases: [card('h1'), gov('h2')], scope: 'refund' }, STRENGTHS),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, 'merge_required');
        assert.match(e.message, /POST \/v1\/subjects\/merge/,
          'a 409 pointing at nothing is a dead end, not a refusal');
        return true;
      });
  });

  test('and the merge actually clears it', async () => {
    const A = await actors();
    await subject(A, [card('h3')]);
    await subject(A, [gov('h4')]);
    await mergeSubjects(A.principal, { aliases: [card('h3'), gov('h4')], ...EV }, STRENGTHS);
    const out = await lookup(A.agent, { aliases: [card('h3'), gov('h4')], scope: 'refund' },
      STRENGTHS);
    assert.equal(out.determinations.length, 0, 'one subject, one answer');
  });
});

/* ── What a merge moves ──────────────────────────────────────────────── */

describe('merging', () => {
  test('unions two subjects into the older one and moves everything', async () => {
    const A = await actors();
    const older = await subject(A, [card('m1')]);
    await seal(A.agent, { idempotencyKey: 'idem-m1', aliases: [card('m1')], scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    const newer = await subject(A, [gov('m2')]);
    assert.notEqual(older, newer);

    const out = await mergeSubjects(A.principal,
      { aliases: [card('m1'), gov('m2')], ...EV }, STRENGTHS);
    assert.equal(out.outcome, 'merged');
    assert.equal(out.subjectId, older, 'the oldest survives — deterministic, and it has the history');
    assert.equal(out.absorbed, 1);
    assert.equal(out.aliasCount, 2);
    assert.equal(await countSubjects(A.ws), 1, 'the absorbed subject is gone');

    // The determination now answers for the alias that never carried it.
    const bound = await lookup(A.agent, { aliases: [gov('m2')], scope: 'refund' }, STRENGTHS);
    assert.equal(bound.determinations.length, 1,
      'a fresh identifier presenting alongside a known one is exactly what merge is for');
  });

  test('the freshest attestation of a contested fact wins', async () => {
    const A = await actors();
    const t0 = new Date(Date.now() - 86_400_000);
    await subject(A, [card('m3')], { delivered: false, at: t0 });
    await subject(A, [gov('m4')], { delivered: true, at: new Date() });

    const out = await mergeSubjects(A.principal,
      { aliases: [card('m3'), gov('m4')], ...EV }, STRENGTHS);
    const { rows } = await getPool().query<{ bool_value: boolean }>(
      'SELECT bool_value FROM attestations WHERE subject_id = $1 AND fact = $2',
      [out.subjectId, 'carrier.delivered']);
    assert.equal(rows.length, 1, 'one subject holds one current value of a fact');
    assert.equal(rows[0]!.bool_value, true, 'the later assertion is the current one');
  });

  test('two subjects holding the same fact do not collide the insert', async () => {
    // ON CONFLICT cannot touch one row twice in a statement, so the move is
    // DISTINCT ON. Three subjects all asserting `carrier.delivered` is the case
    // that finds it.
    const A = await actors();
    await subject(A, [card('m5')]);
    await subject(A, [gov('m6')]);
    await subject(A, [card('m7'), gov('m7b')]);
    const out = await mergeSubjects(A.principal,
      { aliases: [card('m5'), gov('m6'), card('m7')], ...EV }, STRENGTHS);
    assert.equal(out.absorbed, 2);
    const { rows } = await getPool().query(
      'SELECT 1 FROM attestations WHERE subject_id = $1', [out.subjectId]);
    assert.equal(rows.length, 1);
  });

  test('cohort placements move, and a contradiction keeps the survivor band', async () => {
    const A = await actors();
    await declareCohort(A.custodian, { cohort: 'region' });
    await subject(A, [card('m8')]);
    await subject(A, [gov('m9')]);
    await placeInCohort(A.custodian, { aliases: [card('m8')], cohort: 'region', band: 'north' },
      STRENGTHS);
    await placeInCohort(A.custodian, { aliases: [gov('m9')], cohort: 'region', band: 'south' },
      STRENGTHS);

    const out = await mergeSubjects(A.principal,
      { aliases: [card('m8'), gov('m9')], ...EV }, STRENGTHS);
    const { rows } = await getPool().query<{ subject_id: string }>(
      'SELECT subject_id FROM subject_cohorts WHERE workspace_id = $1', [A.ws]);
    assert.equal(rows.length, 1, 'one person is in one band of one cohort');
    assert.equal(rows[0]!.subject_id, out.subjectId);
  });

  test('merging one subject with itself is a no-op that says so', async () => {
    const A = await actors();
    await subject(A, [card('m10'), gov('m11')]);
    const out = await mergeSubjects(A.principal,
      { aliases: [card('m10'), gov('m11')], ...EV }, STRENGTHS);
    assert.equal(out.outcome, 'not_applicable');
    assert.equal(out.absorbed, 0);
  });

  test('and merging again after a merge is idempotent', async () => {
    const A = await actors();
    await subject(A, [card('m12')]);
    await subject(A, [gov('m13')]);
    const first = await mergeSubjects(A.principal,
      { aliases: [card('m12'), gov('m13')], ...EV }, STRENGTHS);
    const again = await mergeSubjects(A.principal,
      { aliases: [card('m12'), gov('m13')], ...EV }, STRENGTHS);
    assert.equal(again.outcome, 'not_applicable');
    assert.equal(again.subjectId, first.subjectId);
  });

  test('the merge is on the record with who acted and on what evidence', async () => {
    const A = await actors();
    await subject(A, [card('m14')]);
    await subject(A, [gov('m15')]);
    await mergeSubjects(A.principal, { aliases: [card('m14'), gov('m15')], ...EV }, STRENGTHS);
    const { rows } = await getPool().query<{
      actor: string; evidence_class: string; detail: { absorbed: string[] };
    }>("SELECT actor, evidence_class, detail FROM subject_events WHERE kind = 'merged' AND workspace_id = $1",
    [A.ws]);
    assert.equal(rows[0]?.actor, 'principal');
    assert.equal(rows[0]?.evidence_class, 'internal');
    assert.equal(rows[0]?.detail.absorbed.length, 1, 'the record names what was absorbed');
  });
});

/* ── The poisoning merge ─────────────────────────────────────────────── */

describe('the four bounds', () => {
  test('a subject reached only by a shared device is not dragged in', async () => {
    const A = await actors();
    await subject(A, [card('p1'), dev('household')]);   // the victim owns the device
    await subject(A, [card('p2')]);                      // the attacker, separately
    // The presentation carries a strong alias — the attacker's own card — and
    // reaches the victim only through the device they happen to share.
    await refuses(() => mergeSubjects(A.principal,
      { aliases: [card('p2'), dev('household')], ...EV }, STRENGTHS),
    'merge_not_justified', 'this is the poisoning merge, and it must not work');
    assert.equal(await countSubjects(A.ws), 2, 'nothing was unioned');
    assert.equal(await subjectEvents(A.ws, 'merge_refused'), 1,
      'the refusal is the signal — a workspace being probed looks like this');
  });

  test('a presentation with no strong alias at all is refused before any lookup', async () => {
    const A = await actors();
    await subject(A, [dev('d1')]);
    await subject(A, [mail('e1')]);
    await refuses(() => mergeSubjects(A.principal,
      { aliases: [dev('d1'), mail('e1')], ...EV }, STRENGTHS),
    'merge_not_justified', 'an email and a device do not establish that two people are one');
  });

  test('more subjects than the degree bound is refused and recorded', async () => {
    const A = await actors();
    const aliases: object[] = [];
    for (let i = 0; i <= MAX_SUBJECTS_PER_MERGE; i++) {
      await subject(A, [card(`deg${i}`)]);
      aliases.push(card(`deg${i}`));
    }
    await refuses(() => mergeSubjects(A.principal, { aliases, ...EV }, STRENGTHS),
      'merge_degree_exceeded',
      'one identifier standing for five people is an attack, not a person');
    assert.equal(await subjectEvents(A.ws, 'merge_refused'), 1);
  });

  test('an agent cannot merge, whatever scopes it holds', async () => {
    const A = await actors();
    await subject(A, [card('a1')]);
    await subject(A, [gov('a2')]);
    // A.agent holds every scope in these tests, including subjects:merge. The
    // authority floor is a second gate, and it is the one that matters.
    await refuses(() => mergeSubjects(A.agent,
      { aliases: [card('a1'), gov('a2')], ...EV }, STRENGTHS),
    'insufficient_authority', 'permanence is not something a scope can convey');
    await refuses(() => mergeSubjects(A.operator,
      { aliases: [card('a1'), gov('a2')], ...EV }, STRENGTHS),
    'insufficient_authority', 'a merge sits above a claw');
  });

  test('an agent talking about itself cannot union two people', async () => {
    const A = await actors();
    await subject(A, [card('s1')]);
    await subject(A, [gov('s2')]);
    for (const cls of ['self', 'signed']) {
      await refuses(() => mergeSubjects(A.principal, { aliases: [card('s1'), gov('s2')],
        evidenceSha256: hash64('x'), evidenceClass: cls }, STRENGTHS),
      'insufficient_evidence', `${cls} never dominates internal`);
    }
    // And the floor is a floor, not an equality: receipt clears it.
    const out = await mergeSubjects(A.principal, { aliases: [card('s1'), gov('s2')],
      evidenceSha256: hash64('x'), evidenceClass: 'receipt' }, STRENGTHS);
    assert.equal(out.outcome, 'merged');
  });

  test('a merge cannot be justified by naming subject ids, because it takes none',
    async () => {
      const A = await actors();
      const s = await subject(A, [card('n1')]);
      await subject(A, [gov('n2')]);
      // There is no parameter to pass. The only way to reach a subject is to
      // demonstrate an alias that resolves to it.
      await refuses(() => mergeSubjects(A.principal, { aliases: [card('nobody')], ...EV },
        STRENGTHS), 'unknown_subject', 'you cannot merge what you cannot identify');
      assert.equal(await countSubjects(A.ws), 2);
      assert.ok(s);
    });
});

/* ── The hole the explicit merge would otherwise have decorated ──────── */

describe('a shared alias cannot union two people implicitly', () => {
  /**
   * `blind.ts` promised from the first commit that only strong aliases may
   * cause a union, and shipped `mergeCapable()` to say so. Nothing called it.
   * Every write path resolved a subject from any presented alias and attached
   * the rest to whatever it found — so an ordinary agent key, with no evidence
   * and no authority, could union two people by presenting its own card
   * alongside a device they shared. A bounded, audited, principal-gated merge
   * endpoint in front of that would have been decoration.
   */
  test('an agent key cannot union two people by presenting a shared device', async () => {
    const A = await actors();
    const victim = await subject(A, [card('victim'), dev('household')]);
    await seal(A.agent, { idempotencyKey: 'idem-v', aliases: [card('victim')], scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);

    const attacker = await attest(A.agent, {
      aliases: [card('attacker'), dev('household')],
      facts: [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }],
    }, STRENGTHS);

    assert.notEqual(attacker.subjectId, victim,
      'no authority, no evidence, no merge call — and it used to be the same subject');
    assert.equal(await countSubjects(A.ws), 2);

    const out = await lookup(A.agent, { aliases: [card('attacker')], scope: 'refund' }, STRENGTHS);
    assert.equal(out.determinations.length, 0,
      "the attacker's card must not inherit the victim's refusal");
  });

  test('the shared alias stays with whoever had it, and still carries a binding', async () => {
    const A = await actors();
    await subject(A, [card('own'), dev('shared')]);
    await seal(A.agent, { idempotencyKey: 'idem-o', aliases: [card('own')], scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    await subject(A, [card('other'), dev('shared')]);

    const { rows } = await getPool().query<{ subject_id: string }>(
      "SELECT subject_id FROM subject_aliases WHERE workspace_id = $1 AND alias_type = 'device'",
      [A.ws]);
    assert.equal(rows.length, 1, 'an alias belongs to one subject, and it did not move');

    // The read path is the other half: a weak alias must still carry a
    // refusal, or the determination is escaped by presenting a new phone.
    const carried = await lookup(A.agent, { aliases: [dev('shared')], scope: 'refund' }, STRENGTHS);
    assert.equal(carried.determinations.length, 1,
      'weak aliases carry bindings; they just cannot create them');
  });

  test('a strong alias still finds the subject it already belongs to', async () => {
    const A = await actors();
    const first = await subject(A, [card('one')]);
    const again = await subject(A, [card('one'), mail('one')]);
    assert.equal(again, first, 'the ordinary case must not have become a new subject');
    const { rows } = await getPool().query<{ n: string }>(
      'SELECT count(*) AS n FROM subject_aliases WHERE subject_id = $1', [first]);
    assert.equal(Number(rows[0]!.n), 2, 'and the weaker alias joined it');
  });

  test('a weak-only presentation still resolves to the subject holding it', async () => {
    const A = await actors();
    const s1 = await subject(A, [dev('lonely')]);
    const s2 = await subject(A, [dev('lonely')]);
    assert.equal(s2, s1, 'nothing capable to decide with, and nothing to union either');
  });

  test('a workspace may lower the threshold to medium, and never to weak', async () => {
    const A = await actors();
    await getPool().query("UPDATE workspaces SET merge_threshold = 'medium' WHERE id = $1", [A.ws]);
    const s1 = await subject(A, [mail('lowered')]);
    const s2 = await subject(A, [card('lowered'), mail('lowered')]);
    assert.equal(s2, s1, 'an email may now decide identity, because the workspace said so');

    await assert.rejects(
      () => getPool().query("UPDATE workspaces SET merge_threshold = 'weak' WHERE id = $1", [A.ws]),
      'no workspace may configure its way into unioning strangers by device id');
  });
});

/* ── The correction ──────────────────────────────────────────────────── */

describe('carve-out', () => {
  test('detaches one alias and the subject stops answering for it', async () => {
    const A = await actors();
    await subject(A, [card('c1')]);
    await subject(A, [gov('c2')]);
    const merged = await mergeSubjects(A.principal,
      { aliases: [card('c1'), gov('c2')], ...EV }, STRENGTHS);
    await seal(A.agent, { idempotencyKey: 'idem-c1', aliases: [card('c1')], scope: 'refund',
      disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    assert.equal((await lookup(A.agent, { aliases: [gov('c2')], scope: 'refund' },
      STRENGTHS)).determinations.length, 1,
    'the wrong merge is doing exactly the harm it is feared for');

    const out = await carveOut(A.principal,
      { alias: gov('c2'), evidenceSha256: hash64('oops'), evidenceClass: 'receipt' }, STRENGTHS);
    assert.equal(out.subjectId, merged.subjectId);
    assert.equal(out.aliasCount, 1);

    const after = await lookup(A.agent, { aliases: [gov('c2')], scope: 'refund' }, STRENGTHS);
    assert.equal(after.determinations.length, 0,
      'the stranger is out from under the determination');
  });

  test('does not rewrite what the wrong merge already decided', async () => {
    const A = await actors();
    await subject(A, [card('c3')]);
    await subject(A, [gov('c4')]);
    await mergeSubjects(A.principal, { aliases: [card('c3'), gov('c4')], ...EV }, STRENGTHS);
    const s = await seal(A.agent, { idempotencyKey: 'idem-c3', aliases: [card('c3')],
      scope: 'refund', disposition: 'bind', rule: RULE, claw: CLAW }, STRENGTHS);
    await carveOut(A.principal,
      { alias: gov('c4'), evidenceSha256: hash64('oops'), evidenceClass: 'receipt' }, STRENGTHS);

    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM seals WHERE id = $1', [s.sealId]);
    assert.equal(rows[0]?.state, 'sealed',
      'a carve-out is not an undo; claiming otherwise would be the larger lie');
    assert.equal(await countEvents(s.sealId!, 'sealed'), 1);
  });

  test('the alias does not quietly reattach on the next attestation', async () => {
    const A = await actors();
    await subject(A, [card('c5')]);
    await subject(A, [gov('c6')]);
    await mergeSubjects(A.principal, { aliases: [card('c5'), gov('c6')], ...EV }, STRENGTHS);
    await carveOut(A.principal,
      { alias: gov('c6'), evidenceSha256: hash64('oops'), evidenceClass: 'receipt' }, STRENGTHS);

    // The exact move that would undo it: present both aliases again. The card
    // resolves to the merged subject; without the carve-out check the gov_id
    // would be reattached to it.
    await attest(A.agent, { aliases: [card('c5'), gov('c6')], facts: [
      { fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }] },
    STRENGTHS);
    const { rows } = await getPool().query<{ subject_id: string }>(
      "SELECT subject_id FROM subject_aliases WHERE workspace_id = $1 AND alias_type = 'gov_id'",
      [A.ws]);
    assert.equal(rows.length, 0, 'a carve-out that the next write undoes is a suggestion');
  });

  test('and a merge cannot walk around a standing carve-out', async () => {
    const A = await actors();
    await subject(A, [card('c7')]);
    await subject(A, [gov('c8')]);
    await mergeSubjects(A.principal, { aliases: [card('c7'), gov('c8')], ...EV }, STRENGTHS);
    await carveOut(A.principal,
      { alias: gov('c8'), evidenceSha256: hash64('oops'), evidenceClass: 'receipt' }, STRENGTHS);
    await subject(A, [gov('c8')]);   // the carved-out alias is its own subject now

    await refuses(() => mergeSubjects(A.principal,
      { aliases: [card('c7'), gov('c8')], ...EV }, STRENGTHS),
    'carve_out_standing', 'the obvious route back must be closed');
  });

  test('carving out requires the same authority and evidence as merging', async () => {
    const A = await actors();
    await subject(A, [card('c9'), gov('c10')]);
    await refuses(() => carveOut(A.operator,
      { alias: gov('c10'), evidenceSha256: hash64('x'), evidenceClass: 'receipt' }, STRENGTHS),
    'insufficient_authority', 'separating people is as consequential as joining them');
    await refuses(() => carveOut(A.principal,
      { alias: gov('c10'), evidenceSha256: hash64('x'), evidenceClass: 'self' }, STRENGTHS),
    'insufficient_evidence', 'an agent cannot detach an identifier on its own say-so');
  });

  test('an alias attached to nothing cannot be carved out', async () => {
    const A = await actors();
    await refuses(() => carveOut(A.principal,
      { alias: gov('nothing'), evidenceSha256: hash64('x'), evidenceClass: 'receipt' }, STRENGTHS),
    'unknown_alias', 'there is nothing to separate');
  });

  test('it is on the record, like every other authority act', async () => {
    const A = await actors();
    await subject(A, [card('c11'), gov('c12')]);
    await carveOut(A.custodian,
      { alias: gov('c12'), evidenceSha256: hash64('x'), evidenceClass: 'authority' }, STRENGTHS);
    assert.equal(await subjectEvents(A.ws, 'carve_out'), 1);
  });
});

/* ── Isolation ───────────────────────────────────────────────────────── */

describe('a merge cannot reach across a workspace', () => {
  test('the same alias values in two workspaces are two unrelated people', async () => {
    const [A, B] = [await actors(), await actors()];
    await subject(A, [card('w1')]);
    await subject(B, [card('w1')]);
    await subject(B, [gov('w2')]);
    await mergeSubjects(B.principal, { aliases: [card('w1'), gov('w2')], ...EV }, STRENGTHS);
    assert.equal(await countSubjects(A.ws), 1, "the other tenant's merge changed nothing here");
  });
});
