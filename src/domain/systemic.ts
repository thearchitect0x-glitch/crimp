// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-06 · One ruling, every case it reaches.
 *
 * THE FACT FAMILY. An adjudication is attested about the appellant, by the
 * hearing authority as a named source, as ordinary facts:
 *
 *   adjudication.ruling     str   reversed | affirmed | remanded
 *   adjudication.ruleset    str   the ruleset of the rule the ruling condemns
 *   adjudication.rule_id    str   its id
 *   adjudication.pattern    str   optional: a fact the rule may not rest on
 *   adjudication.authority  str   fair_hearing | state_review | court | …
 *   adjudication.date       time  when the ruling issued
 *
 * Nothing about this family is special to the evaluator — it is a set of
 * facts about one person. What is special is what the SWEEP does when it
 * sees `ruling = reversed` with a rule named — and WHO may say it: a person
 * (operator or above) through an `authority`-class source. A ruling is the
 * one attestation that reaches other people's records, so it is the one an
 * agent may not make. Then: it finds every open
 * determination made under that rule and puts it under review.
 *
 * WHAT "UNDER REVIEW" MEANS, EXACTLY. The determination is marked due, so
 * the correction channel re-examines it promptly; `review_flagged_at` is set,
 * so every lookup, proof and notice shows it; a `systemic_review` event is
 * on its record; and one finding names every affected determination. Its
 * state does not change. A ruling that a rule is wrong does not say what the
 * right rule is — closing the version and committing a successor is the
 * operator's act (cap-08), and re-determining each case is a person's
 * (cap-10). This module makes the set of cases complete and visible, which
 * is the part a person cannot do by hand.
 *
 * WHY NOT ATTACH THE RULING TO EVERY RECORD AS A FACT. The brief suggests it.
 * A fact is a claim by a source about a subject; writing the appellant's
 * ruling onto other people's records would have the sweep attest things
 * nobody attested, and re-evaluating an unchanged rule against unchanged
 * facts would change nothing anyway. The review flag says the same thing
 * without pretending to be evidence.
 *
 * "THE SAME RULE" IS CONTENT. A registered id matches by `rule_ref`; an
 * inline rule matches when its hash equals any version of that id. That is
 * what content-addressed versions (cap-08) were for.
 */
import { withTx, getPool, type Db } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { recordFinding } from './findings.js';

export const ADJUDICATION = {
  ruling: 'adjudication.ruling',
  ruleset: 'adjudication.ruleset',
  ruleId: 'adjudication.rule_id',
  pattern: 'adjudication.pattern',
  authority: 'adjudication.authority',
  date: 'adjudication.date',
} as const;
export const RULINGS = ['reversed', 'affirmed', 'remanded'] as const;

export interface SystemicReview {
  id: string;
  ruleset: string;
  ruleId: string;
  pattern: string | null;
  affected: string[];
  findingId: string | null;
}

interface Reversal {
  subject_id: string; asserted_at: Date; ruleset: string | null; rule_id: string | null;
  pattern: string | null; authority: string | null; date: number | null; source: string;
}

/** Reversed rulings that name a rule and have not yet been propagated. */
async function pendingReversals(db: Db, workspaceId: string): Promise<Reversal[]> {
  const { rows } = await db.query<Reversal>(
    `SELECT r.subject_id, r.asserted_at, r.source,
            (SELECT str_value FROM attestations a WHERE a.workspace_id = r.workspace_id
               AND a.subject_id = r.subject_id AND a.fact = $2) AS ruleset,
            (SELECT str_value FROM attestations a WHERE a.workspace_id = r.workspace_id
               AND a.subject_id = r.subject_id AND a.fact = $3) AS rule_id,
            (SELECT str_value FROM attestations a WHERE a.workspace_id = r.workspace_id
               AND a.subject_id = r.subject_id AND a.fact = $4) AS pattern,
            (SELECT str_value FROM attestations a WHERE a.workspace_id = r.workspace_id
               AND a.subject_id = r.subject_id AND a.fact = $5) AS authority,
            (SELECT int_value FROM attestations a WHERE a.workspace_id = r.workspace_id
               AND a.subject_id = r.subject_id AND a.fact = $6) AS date
       FROM attestations r
       JOIN api_keys k ON k.id = r.attester AND k.workspace_id = r.workspace_id
       JOIN authority_levels al ON al.level = k.authority
      WHERE r.workspace_id = $1 AND r.fact = $7 AND r.str_value = 'reversed'
        -- Who may put every determination under a rule into review: a person
        -- (operator or above), attesting through a source of the authority
        -- class. An agent holding attestations:write can attest the same
        -- facts; they propagate nothing. Found by the security sweep — the
        -- sweep had read the ruling and never asked who said it.
        AND r.admissibility = 'authority'
        AND al.rank >= (SELECT rank FROM authority_levels WHERE level = 'operator')
        AND NOT EXISTS (SELECT 1 FROM systemic_reviews s
                         WHERE s.workspace_id = r.workspace_id
                           AND s.appellant_subject_id = r.subject_id
                           AND s.ruling_asserted_at = r.asserted_at)
      ORDER BY r.asserted_at`,
    [workspaceId, ADJUDICATION.ruleset, ADJUDICATION.ruleId, ADJUDICATION.pattern,
      ADJUDICATION.authority, ADJUDICATION.date, ADJUDICATION.ruling]);
  return rows;
}

/**
 * Every open determination made under the rule: by registered id, or by
 * identical content. Narrowed to those whose reasons rest on `pattern` when
 * the ruling names one — a rule may be sound and one clause of it not.
 */
async function affectedSeals(db: Db, workspaceId: string, r: {
  ruleset: string; rule_id: string; pattern: string | null;
}): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM seals
      WHERE workspace_id = $1 AND state IN ('sealed', 'tainted')
        AND ((rule_ref->>'ruleset' = $2 AND rule_ref->>'rule_id' = $3)
             OR rule_hash IN (SELECT version FROM rules
                               WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3))
        AND ($4::text IS NULL OR reasons @> jsonb_build_array(jsonb_build_object('fact', $4::text)))
      ORDER BY sealed_at`,
    [workspaceId, r.ruleset, r.rule_id, r.pattern]);
  return rows.map((x) => x.id);
}

export interface Propagation { reviews: SystemicReview[]; flagged: number }

/** Called by the sweep. Idempotent: a ruling propagates once. */
export async function propagateAdjudications(workspaceId: string): Promise<Propagation> {
  const pool = getPool();
  const out: Propagation = { reviews: [], flagged: 0 };
  for (const r of await pendingReversals(pool, workspaceId)) {
    // A reversal that names no rule is about one person only. It is still
    // recorded as propagated so the sweep stops looking at it.
    const named = r.ruleset !== null && r.rule_id !== null;
    const review = await withTx(async (tx): Promise<SystemicReview | null> => {
      const { rows: claimed } = await tx.query(
        `INSERT INTO systemic_reviews (id, workspace_id, appellant_subject_id, ruling_asserted_at,
                                       ruleset, rule_id, pattern, affected_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0) ON CONFLICT DO NOTHING RETURNING id`,
        [newId('rev'), workspaceId, r.subject_id, r.asserted_at,
          r.ruleset ?? '', r.rule_id ?? '', r.pattern]);
      if (!claimed[0] || !named) return null;
      const id = (claimed[0] as { id: string }).id;
      const affected = await affectedSeals(tx, workspaceId, { ruleset: r.ruleset!, rule_id: r.rule_id!, pattern: r.pattern });

      const detail = {
        ruleset: r.ruleset, rule_id: r.rule_id, pattern: r.pattern,
        adjudication: { authority: r.authority, source: r.source,
          date: r.date === null ? null : new Date(Number(r.date)).toISOString(),
          asserted_at: r.asserted_at.toISOString() },
      };
      if (affected.length > 0) {
        await tx.query(
          `UPDATE seals SET evaluation_due = true, review_flagged_at = coalesce(review_flagged_at, now())
            WHERE workspace_id = $1 AND id = ANY($2::text[])`, [workspaceId, affected]);
        await tx.query(
          `INSERT INTO seal_events (seal_id, workspace_id, kind, detail)
           SELECT unnest($2::text[]), $1, 'systemic_review', $3::jsonb`,
          [workspaceId, affected, JSON.stringify(detail)]);
      }
      const finding = await recordFinding(tx, workspaceId, {
        class: 'systemic_review', subjectKind: 'rule', subjectId: `${r.ruleset}/${r.rule_id}`,
        detail: { ...detail, affected, count: affected.length },
      });
      await tx.query('UPDATE systemic_reviews SET affected_count = $2, finding_id = $3 WHERE id = $1',
        [id, affected.length, finding?.id ?? null]);
      return { id, ruleset: r.ruleset!, ruleId: r.rule_id!, pattern: r.pattern, affected,
        findingId: finding?.id ?? null };
    });
    if (review !== null) {
      out.reviews.push(review);
      out.flagged += review.affected.length;
    }
  }
  return out;
}

/** Workspaces holding a reversal the sweep has not yet propagated. */
export async function workspacesWithPendingReversals(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT r.workspace_id FROM attestations r
       JOIN api_keys k ON k.id = r.attester AND k.workspace_id = r.workspace_id
       JOIN authority_levels al ON al.level = k.authority
      WHERE r.fact = $1 AND r.str_value = 'reversed'
        AND r.admissibility = 'authority'
        AND al.rank >= (SELECT rank FROM authority_levels WHERE level = 'operator')
        AND NOT EXISTS (SELECT 1 FROM systemic_reviews s
                         WHERE s.workspace_id = r.workspace_id
                           AND s.appellant_subject_id = r.subject_id
                           AND s.ruling_asserted_at = r.asserted_at)`,
    [ADJUDICATION.ruling]);
  return rows.map((x) => x.workspace_id);
}
