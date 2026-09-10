// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Subject merge, and the carve-out that is its only correction.
 *
 * `check` sits in front of every agent action, and until this landed it could
 * throw `merge_required` — a 409 telling the caller to resolve a merge through
 * an endpoint that did not exist. A gate that cannot answer is not failing
 * closed; it is failing silent, and the agent is left choosing between acting
 * unsafely and refusing to serve somebody permanently.
 *
 * WHY THIS IS THE MOST DANGEROUS OPERATION IN THE SYSTEM.
 *
 * A merge is monotone — it only ever adds bindings — which is what stops the
 * obvious evasion: a fresh email presenting a known card is dragged under the
 * existing determination. The same property makes a wrong merge permanent. A
 * POISONING MERGE presents your own identifier alongside a widely-shared one,
 * forces the union, and drags strangers under somebody else's refusal.
 *
 * So the operation is bounded four ways, and none of them is a policy document:
 *
 *   1. EVERY subject drawn into a merge must be reached by a merge-capable
 *      alias. Not "the presentation contains one strong alias somewhere" — each
 *      subject individually. A household device may inherit a refusal and must
 *      never unify two strangers.
 *   2. Degree bounds: at most MAX_SUBJECTS_PER_MERGE subjects at once, and the
 *      union may not exceed MAX_ALIASES_PER_SUBJECT components.
 *   3. `principal` authority and evidence dominating `internal`, so an agent's
 *      own word — `self` or `signed` — can never union two people.
 *   4. A standing carve-out blocks the merge that would circumvent it.
 *
 * A refused merge is RECORDED. The refusal is the signal, not merely a guard:
 * a workspace being probed for poisonable subjects looks like repeated
 * `merge_refused` events long before it looks like anything else.
 *
 * WHAT THIS DOES NOT DO. It does not un-merge, and nothing can. A carve-out
 * detaches one alias from one subject going forward; the determinations the
 * wrong merge already produced stay on the record, because rewriting them
 * would be the larger lie.
 */
import pg from 'pg';
import { getPool, withTx } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import {
  blindAlias, blindAliases, mergeCapable, MAX_ALIASES_PER_SUBJECT, MAX_SUBJECTS_PER_MERGE,
  type BlindedAlias, type MergeStrength,
} from '../lib/blind.js';
import { dominates, type Admissibility } from './admissibility.js';
import { rankOf } from './authority.js';
import { requireScope, type Principal } from './auth.js';

/**
 * A merge may not be authorised by the party it benefits talking to itself.
 *
 * `internal` is the operator's own system of record — interested, but
 * accountable. `self` and `signed` sit below it and can never clear the floor,
 * which is the same reasoning that stops an agent clawing its own refusal.
 */
export const MERGE_EVIDENCE_FLOOR: Admissibility = 'internal';

/** Merging is permanent and unreviewable, so it sits above clawing. */
export const MERGE_AUTHORITY = 'principal';

export interface MergeResult {
  subjectId: string;
  /** `not_applicable` when the aliases already identified one subject. */
  outcome: 'merged' | 'not_applicable';
  absorbed: number;
  aliasCount: number;
}

interface Candidate { subjectId: string; strong: boolean }

function requireMergeAuthority(p: Principal, what: string): void {
  if (rankOf(p.authority) < rankOf(MERGE_AUTHORITY)) {
    throw new ApiError(403, 'insufficient_authority',
      `${what} requires ${MERGE_AUTHORITY} authority; this key is ${p.authority}. `
      + 'A union of two people is permanent and cannot be reviewed away.',
      { required: MERGE_AUTHORITY, held: p.authority });
  }
}

function requireEvidence(evidenceClass: string): Admissibility {
  if (!dominates(evidenceClass as Admissibility, MERGE_EVIDENCE_FLOOR)) {
    throw new ApiError(403, 'insufficient_evidence',
      `Evidence of class "${evidenceClass}" does not meet the floor of `
      + `"${MERGE_EVIDENCE_FLOOR}". An agent's own account of who somebody is cannot `
      + 'unify two people; that is the poisoning merge, written down.',
      { required: MERGE_EVIDENCE_FLOOR, offered: evidenceClass });
  }
  return evidenceClass as Admissibility;
}

/**
 * Which subjects do these aliases reach, and was each reached by an alias
 * strong enough to justify unifying it with the others?
 *
 * A carved-out (alias, subject) pair is invisible here — that is what a
 * carve-out is for.
 */
async function candidates(
  tx: pg.PoolClient, workspaceId: string, aliases: readonly BlindedAlias[],
): Promise<Candidate[]> {
  const capable = new Set(mergeCapable(aliases).map((a) => `${a.type}:${a.blinded}`));
  const { rows } = await tx.query<{ subject_id: string; alias_type: string; blinded: string }>(
    `SELECT sa.subject_id, sa.alias_type, sa.blinded
       FROM subject_aliases sa
      WHERE sa.workspace_id = $1
        AND (sa.alias_type, sa.blinded) IN (SELECT * FROM UNNEST($2::text[], $3::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM alias_carve_outs co
           WHERE co.workspace_id = sa.workspace_id
             AND co.alias_type   = sa.alias_type
             AND co.blinded      = sa.blinded
             AND co.subject_id   = sa.subject_id)`,
    [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded)]);

  const bySubject = new Map<string, boolean>();
  for (const r of rows) {
    const strong = capable.has(`${r.alias_type}:${r.blinded}`);
    bySubject.set(r.subject_id, (bySubject.get(r.subject_id) ?? false) || strong);
  }
  return [...bySubject].map(([subjectId, strong]) => ({ subjectId, strong }));
}

/**
 * Record a refusal so it survives the throw that accompanies it.
 *
 * NOT on the transaction. The refusal is written and then the merge throws,
 * which rolls the transaction back — so a refusal recorded on `tx` records
 * nothing at all, and "a refused merge is recorded" becomes a comment rather
 * than a fact. A test caught this by counting the events rather than trusting
 * the code path. Its own connection commits independently.
 *
 * The consequence is deliberate: the refusal survives even though nothing else
 * in the attempt did. That is the correct asymmetry — a workspace being probed
 * for poisonable subjects is visible precisely in the attempts that failed.
 */
async function recordRefusal(
  _tx: pg.PoolClient, workspaceId: string, actor: string,
  evidenceSha256: string, evidenceClass: string, detail: Record<string, unknown>,
): Promise<void> {
  await getPool().query(
    `INSERT INTO subject_events
       (workspace_id, subject_id, kind, actor, evidence_sha256, evidence_class, detail)
     VALUES ($1, NULL, 'merge_refused', $2, $3, $4, $5::jsonb)`,
    [workspaceId, actor, evidenceSha256, evidenceClass, JSON.stringify(detail)]);
}

export async function mergeSubjects(p: Principal, args: {
  aliases: unknown;
  evidenceSha256: string;
  evidenceClass: string;
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<MergeResult> {
  requireScope(p, 'subjects:merge');
  requireMergeAuthority(p, 'Merging two subjects');
  const workspaceId = p.workspaceId;
  const actor = p.authority;
  if (typeof args.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(args.evidenceSha256)) {
    throw new ApiError(400, 'invalid_request',
      'evidence_sha256 must be 64 lowercase hex characters. Crimp holds the commitment, '
      + 'never the evidence itself.');
  }
  const evidenceClass = requireEvidence(args.evidenceClass);
  const aliases = blindAliases(workspaceId, args.aliases, strengths);

  // Refused up front rather than discovered halfway: a presentation carrying no
  // strong alias cannot unify anybody, whatever it happens to touch.
  if (mergeCapable(aliases).length === 0) {
    throw new ApiError(400, 'merge_not_justified',
      'None of these aliases is strong enough to cause a merge. Only an identifier bound to '
      + 'one person by an issuing authority or a payment network may unify subjects.',
      { presented: aliases.map((a) => a.type) });
  }

  return withTx(async (tx) => {
    const found = await candidates(tx, workspaceId, aliases);

    if (found.length === 0) {
      throw new ApiError(404, 'unknown_subject',
        'No subject matches these aliases, so there is nothing to merge.');
    }
    if (found.length === 1) {
      // Idempotent by construction: the second call finds one subject and says
      // so, rather than reporting a merge that did not happen.
      const { rows } = await tx.query<{ alias_count: number }>(
        'SELECT alias_count FROM subjects WHERE id = $1', [found[0]!.subjectId]);
      return {
        subjectId: found[0]!.subjectId, outcome: 'not_applicable' as const,
        absorbed: 0, aliasCount: rows[0]?.alias_count ?? 0,
      };
    }

    // THE CONSTRAINT THAT MATTERS. Not "the presentation contains a strong
    // alias" — each subject drawn in must itself be reached by one. Otherwise
    // presenting your own card alongside a shared household device unifies you
    // with whoever else uses that device, which is the poisoning merge exactly.
    const weak = found.filter((c) => !c.strong);
    if (weak.length > 0) {
      await recordRefusal(tx, workspaceId, actor, args.evidenceSha256, evidenceClass,
        { reason: 'weakly_reached', subjects: found.length, weak: weak.length });
      throw new ApiError(409, 'merge_not_justified',
        `${weak.length} of these ${found.length} subjects is reached only by an alias too weak `
        + 'to cause a merge. A shared identifier may carry a determination; it may not unify '
        + 'strangers. Present a strong alias for every subject, or merge them separately.',
        { subjects: found.length, weaklyReached: weak.length });
    }

    if (found.length > MAX_SUBJECTS_PER_MERGE) {
      await recordRefusal(tx, workspaceId, actor, args.evidenceSha256, evidenceClass,
        { reason: 'degree_exceeded', subjects: found.length, limit: MAX_SUBJECTS_PER_MERGE });
      throw new ApiError(409, 'merge_degree_exceeded',
        `This presentation unifies ${found.length} subjects; at most ${MAX_SUBJECTS_PER_MERGE} `
        + 'may be merged at once. One identifier standing for that many people is far more '
        + 'likely to be a poisoning attempt than a person.',
        { subjects: found.length, limit: MAX_SUBJECTS_PER_MERGE });
    }

    // A carve-out standing anywhere in the candidate set blocks the merge. Not
    // strictly airtight — a later merge through a third subject can still
    // re-associate what a carve-out separated — but it closes the direct route,
    // and the limitation is stated in ASSURANCE_CASE.md rather than hidden.
    const { rows: blocked } = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM alias_carve_outs
        WHERE workspace_id = $1 AND subject_id = ANY($2::text[])`,
      [workspaceId, found.map((c) => c.subjectId)]);
    if (Number(blocked[0]?.n ?? 0) > 0) {
      await recordRefusal(tx, workspaceId, actor, args.evidenceSha256, evidenceClass,
        { reason: 'carve_out_standing', subjects: found.length });
      throw new ApiError(409, 'carve_out_standing',
        'A carve-out stands against one of these subjects. Merging them would undo by the '
        + 'side door what an authority separated deliberately.',
        { subjects: found.length });
    }

    const ids = found.map((c) => c.subjectId);
    const { rows: sizes } = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM subject_aliases
        WHERE workspace_id = $1 AND subject_id = ANY($2::text[])`, [workspaceId, ids]);
    // Aliases presented but not yet attached count toward the union too.
    const { rows: fresh } = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM UNNEST($2::text[], $3::text[]) AS u(t, b)
        WHERE NOT EXISTS (SELECT 1 FROM subject_aliases sa
                           WHERE sa.workspace_id = $1 AND sa.alias_type = u.t
                             AND sa.blinded = u.b)`,
      [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded)]);
    const union = Number(sizes[0]!.n) + Number(fresh[0]!.n);
    if (union > MAX_ALIASES_PER_SUBJECT) {
      await recordRefusal(tx, workspaceId, actor, args.evidenceSha256, evidenceClass,
        { reason: 'subject_too_large', union, limit: MAX_ALIASES_PER_SUBJECT });
      throw new ApiError(409, 'subject_too_large',
        `The union would hold ${union} aliases; the limit is ${MAX_ALIASES_PER_SUBJECT}. A `
        + 'subject that has absorbed this much has stopped describing a person.',
        { union, limit: MAX_ALIASES_PER_SUBJECT });
    }

    // Oldest wins. Deterministic, and it keeps the longest history intact —
    // seals move either way, but the subject id in an operator's notes does not.
    const { rows: ordered } = await tx.query<{ id: string }>(
      `SELECT id FROM subjects WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [ids]);
    const winner = ordered[0]!.id;
    const losers = ordered.slice(1).map((r) => r.id);

    // Attestations first, and DISTINCT ON because two losers may hold the same
    // fact: ON CONFLICT cannot touch one row twice in a single statement. The
    // freshest assertion wins, on both sides of the conflict.
    await tx.query(
      `INSERT INTO attestations (workspace_id, subject_id, fact, fact_type, bool_value,
                                 int_value, str_value, source, admissibility, asserted_at,
                                 expires_at, received_at)
       SELECT DISTINCT ON (fact) workspace_id, $2, fact, fact_type, bool_value,
              int_value, str_value, source, admissibility, asserted_at, expires_at, received_at
         FROM attestations
        WHERE workspace_id = $1 AND subject_id = ANY($3::text[])
        ORDER BY fact, asserted_at DESC
       ON CONFLICT (workspace_id, subject_id, fact) DO UPDATE SET
         fact_type = EXCLUDED.fact_type, bool_value = EXCLUDED.bool_value,
         int_value = EXCLUDED.int_value, str_value = EXCLUDED.str_value,
         source = EXCLUDED.source, admissibility = EXCLUDED.admissibility,
         asserted_at = EXCLUDED.asserted_at, expires_at = EXCLUDED.expires_at,
         received_at = EXCLUDED.received_at
        WHERE EXCLUDED.asserted_at > attestations.asserted_at`,
      [workspaceId, winner, losers]);

    // Cohort placements move the same way. A conflict keeps the winner's band:
    // two bands for one person in one cohort is a contradiction the merge
    // cannot resolve, and inventing an answer is worse than keeping one.
    await tx.query(
      `INSERT INTO subject_cohorts (workspace_id, subject_id, cohort, band)
       SELECT DISTINCT ON (cohort) workspace_id, $2, cohort, band
         FROM subject_cohorts
        WHERE workspace_id = $1 AND subject_id = ANY($3::text[])
        ORDER BY cohort, created_at DESC
       ON CONFLICT (workspace_id, subject_id, cohort) DO NOTHING`,
      [workspaceId, winner, losers]);

    // Seals carry their own pressure and facts by foreign key, so moving the
    // seal moves the whole determination with it.
    const { rowCount: sealsMoved } = await tx.query(
      'UPDATE seals SET subject_id = $2 WHERE workspace_id = $1 AND subject_id = ANY($3::text[])',
      [workspaceId, winner, losers]);

    // The primary key is (workspace, type, blinded), so no alias can collide.
    await tx.query(
      `UPDATE subject_aliases SET subject_id = $2
        WHERE workspace_id = $1 AND subject_id = ANY($3::text[])`,
      [workspaceId, winner, losers]);

    // Whatever did not move — an older attestation of a fact the winner already
    // held — goes with the row it belonged to. That is the merge's one lossy
    // step and it is bounded to superseded values.
    await tx.query('DELETE FROM subjects WHERE workspace_id = $1 AND id = ANY($2::text[])',
      [workspaceId, losers]);

    await tx.query(
      `UPDATE subjects SET alias_count =
         (SELECT count(*) FROM subject_aliases WHERE subject_id = $1) WHERE id = $1`, [winner]);
    const { rows: after } = await tx.query<{ alias_count: number }>(
      'SELECT alias_count FROM subjects WHERE id = $1', [winner]);

    await tx.query(
      `INSERT INTO subject_events
         (workspace_id, subject_id, kind, actor, evidence_sha256, evidence_class, detail)
       VALUES ($1,$2,'merged',$3,$4,$5,$6::jsonb)`,
      [workspaceId, winner, actor, args.evidenceSha256, evidenceClass,
        JSON.stringify({ absorbed: losers, seals_moved: sealsMoved ?? 0 })]);

    return {
      subjectId: winner, outcome: 'merged' as const,
      absorbed: losers.length, aliasCount: after[0]?.alias_count ?? 0,
    };
  });
}

export interface CarveOutResult { subjectId: string; aliasCount: number }

/**
 * Detach one alias from one subject, permanently.
 *
 * This is the only correction a merge has, and it is deliberately weaker than
 * an undo. It cannot restore the subjects a union destroyed and it does not
 * touch the determinations that union already produced — rewriting those would
 * be the larger lie. What it does is stop the wrong binding from applying to
 * anything from here on, and record who decided that and on what evidence.
 *
 * Shares `subjects:merge` with the merge itself, because a key that can union
 * two people and cannot separate them is worse than one that can do neither.
 */
export async function carveOut(p: Principal, args: {
  alias: { type: string; value: string };
  evidenceSha256: string;
  evidenceClass: string;
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<CarveOutResult> {
  requireScope(p, 'subjects:merge');
  requireMergeAuthority(p, 'Carving an alias out of a subject');
  const workspaceId = p.workspaceId;
  if (typeof args.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(args.evidenceSha256)) {
    throw new ApiError(400, 'invalid_request',
      'evidence_sha256 must be 64 lowercase hex characters.');
  }
  const evidenceClass = requireEvidence(args.evidenceClass);
  // Validated through the same path as any other alias, so an undeclared type
  // is refused here exactly as it would be on the way in.
  const [only] = blindAliases(workspaceId, [args.alias], strengths);
  const blinded = only ? only.blinded : blindAlias(workspaceId, args.alias.type, args.alias.value);

  return withTx(async (tx) => {
    const { rows } = await tx.query<{ subject_id: string }>(
      `SELECT subject_id FROM subject_aliases
        WHERE workspace_id = $1 AND alias_type = $2 AND blinded = $3`,
      [workspaceId, args.alias.type, blinded]);
    const subjectId = rows[0]?.subject_id;
    if (subjectId === undefined) {
      throw new ApiError(404, 'unknown_alias',
        'This alias is not attached to any subject, so there is nothing to carve out.');
    }

    await tx.query(
      `INSERT INTO alias_carve_outs
         (workspace_id, alias_type, blinded, subject_id, actor, evidence_sha256, evidence_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, alias_type, blinded, subject_id) DO NOTHING`,
      [workspaceId, args.alias.type, blinded, subjectId, p.authority,
        args.evidenceSha256, evidenceClass]);
    await tx.query(
      `DELETE FROM subject_aliases WHERE workspace_id = $1 AND alias_type = $2 AND blinded = $3`,
      [workspaceId, args.alias.type, blinded]);
    await tx.query(
      `UPDATE subjects SET alias_count =
         (SELECT count(*) FROM subject_aliases WHERE subject_id = $1) WHERE id = $1`, [subjectId]);
    const { rows: after } = await tx.query<{ alias_count: number }>(
      'SELECT alias_count FROM subjects WHERE id = $1', [subjectId]);

    await tx.query(
      `INSERT INTO subject_events
         (workspace_id, subject_id, kind, actor, evidence_sha256, evidence_class, detail)
       VALUES ($1,$2,'carve_out',$3,$4,$5,$6::jsonb)`,
      [workspaceId, subjectId, p.authority, args.evidenceSha256, evidenceClass,
        JSON.stringify({ alias_type: args.alias.type })]);

    return { subjectId, aliasCount: after[0]?.alias_count ?? 0 };
  });
}
