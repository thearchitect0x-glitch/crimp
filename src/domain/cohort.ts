// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Cohorts: the measurement the product is for, and the one that could become a
 * weapon.
 *
 * 80.7% of appealed denials are overturned and 6.2% of denials are appealed.
 * The 6.2% are not a random draw. Without cohorts you can measure that errors
 * exist; with them you can measure WHOSE errors go uncorrected, which is the
 * only question those numbers actually raise.
 *
 * A system where institutions tag people by attribute is a discrimination tool
 * wearing a fairness label, so the constraints are structural rather than
 * procedural:
 *
 *   1. Membership is blinded, exactly like an alias, under a different domain
 *      prefix so a band can never be presented as an alias.
 *   2. THERE IS NO PER-SUBJECT COHORT READ IN THIS CODEBASE. Not gated, not
 *      permissioned — not implemented. There is nothing to abuse, nothing to
 *      misconfigure, and nothing to subpoena.
 *   3. A declared cohort may not also be attested as a fact, and a name already
 *      attested as a fact may not be declared as a cohort. A cohort therefore
 *      cannot reach the rule grammar and cannot appear in a determination.
 *   4. Aggregates, when they land, return null below a k-anonymity floor — the
 *      same discipline as the volume floor on every other measurement.
 *
 * The aggregate query is deliberately NOT here yet. The schema and the refusals
 * are the part that has to be right before anybody integrates; the query is
 * additive and can wait for a design partner who needs it.
 *
 * Cohorts exist to measure the system. Never to decide about a person.
 */
import { withTx } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { blindAliases, blindBand, type MergeStrength } from '../lib/blind.js';
import { requireScope, type Principal } from './auth.js';

const COHORT_NAME = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_BAND_LENGTH = 256;

/** Below this many members a band is identifying, not aggregating. */
export const K_ANONYMITY_FLOOR = 20;

/**
 * Declare a cohort type this workspace will measure itself against.
 *
 * Refused if the name is already in use as a fact. The two namespaces are kept
 * disjoint in both directions because the whole guarantee is that a cohort
 * cannot influence a decision, and a fact can.
 */
export async function declareCohort(p: Principal, args: {
  cohort: string;
  description?: string | null;
}): Promise<{ cohort: string }> {
  requireScope(p, 'cohorts:write');
  const workspaceId = p.workspaceId;
  if (typeof args.cohort !== 'string' || !COHORT_NAME.test(args.cohort)) {
    throw new ApiError(400, 'invalid_request',
      `Cohort name ${JSON.stringify(args.cohort)} is not usable. Lowercase, starts with a `
      + 'letter, letters digits and underscores, at most 31 characters.');
  }

  return withTx(async (tx) => {
    const { rows: clash } = await tx.query<{ n: string }>(
      'SELECT count(*) AS n FROM attestations WHERE workspace_id = $1 AND fact = $2',
      [workspaceId, args.cohort]);
    if (Number(clash[0]?.n ?? 0) > 0) {
      throw new ApiError(409, 'cohort_is_a_fact',
        `"${args.cohort}" is already attested as a fact in this workspace, so it can reach a `
        + 'rule. A cohort must never be able to decide about a person. Choose another name.',
        { name: args.cohort });
    }
    await tx.query(
      `INSERT INTO cohort_types (workspace_id, cohort, description) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, cohort) DO NOTHING`,
      [workspaceId, args.cohort, args.description ?? null]);
    return { cohort: args.cohort };
  });
}

/**
 * Place a subject in a band of a declared cohort.
 *
 * The band value is blinded on the way in and never stored in the clear, so
 * Crimp can count the members of a band without ever learning which band it is.
 * There is no call anywhere that reads it back.
 */
export async function placeInCohort(p: Principal, args: {
  aliases: unknown;
  cohort: string;
  band: string;
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<{ subjectId: string }> {
  requireScope(p, 'cohorts:write');
  const workspaceId = p.workspaceId;
  if (typeof args.band !== 'string' || args.band.length === 0
      || args.band.length > MAX_BAND_LENGTH) {
    throw new ApiError(400, 'invalid_request',
      `A band must be a string of 1 to ${MAX_BAND_LENGTH} characters. Send the value itself — `
      + 'only a keyed hash of it is stored.');
  }
  const aliases = blindAliases(workspaceId, args.aliases, strengths);

  return withTx(async (tx) => {
    const { rows: declared } = await tx.query(
      'SELECT 1 FROM cohort_types WHERE workspace_id = $1 AND cohort = $2',
      [workspaceId, args.cohort]);
    if (declared.length === 0) {
      throw new ApiError(400, 'unknown_cohort',
        `Cohort "${args.cohort}" is not declared in this workspace.`, { cohort: args.cohort });
    }

    const { rows: found } = await tx.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM subject_aliases
        WHERE workspace_id = $1 AND (alias_type, blinded) IN (
          SELECT * FROM UNNEST($2::text[], $3::text[]))`,
      [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded)]);
    if (found.length > 1) {
      throw new ApiError(409, 'merge_required',
        'These aliases identify several subjects; resolve the merge before placing.');
    }
    // No subject is created here. A cohort placement is a statement about
    // somebody the system already knows; creating a subject from one would
    // make this table the way people enter Crimp, which is backwards.
    const subjectId = found[0]?.subject_id;
    if (subjectId === undefined) {
      throw new ApiError(404, 'unknown_subject',
        'No subject matches these aliases. Attest something about them first.');
    }

    await tx.query(
      `INSERT INTO subject_cohorts (workspace_id, subject_id, cohort, band) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id, subject_id, cohort) DO UPDATE SET band = EXCLUDED.band`,
      [workspaceId, subjectId, args.cohort, blindBand(workspaceId, args.cohort, args.band)]);
    return { subjectId };
  });
}
