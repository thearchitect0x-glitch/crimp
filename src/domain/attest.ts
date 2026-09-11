// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Attestation: the customer asserting a fact about a subject.
 *
 * Crimp never fetches. The customer pushes, which is what keeps the central
 * safety property intact — no vendor credentials, no outbound access to
 * customer systems, nothing for a compromised Crimp to reach with.
 *
 * The cost is stated rather than patched: the customer is the trust root for
 * its own facts, so an institution that attests falsely can produce a valid
 * proof of a wrong decision. Admissibility narrows this — a claw rule
 * demanding disinterested evidence cannot be satisfied by an institution
 * talking to itself — but it does not close it, and closing it would require
 * holding credentials, which would destroy the product to save it.
 *
 * Only the CURRENT value is stored. Re-attesting overwrites, and a seal keeps
 * only the digest of what it read at the time, so there is no historical value
 * anywhere for an erasure request to have to reach.
 */
import { withTx } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { blindAliases, type MergeStrength } from '../lib/blind.js';
import { resolveForWrite } from './subject.js';
import { FACT_TYPES, type FactType } from './rule.js';
import { requireScope, type Principal } from './auth.js';
import { markDue, reexecuteSubject } from './seal.js';
import { loadCatalogue, assertCatalogued, assertAttestable } from './catalogue.js';

const FACT_NAME = /^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$/;
const MAX_STRING = 256;

export interface AttestInput {
  fact: string;
  type: FactType;
  value: boolean | number | string;
  source: string;
  assertedAt?: Date;
  expiresAt?: Date | null;
}

export async function attest(p: Principal, args: {
  aliases: unknown;
  facts: readonly AttestInput[];
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<{ subjectId: string; count: number }> {
  requireScope(p, 'attestations:write');
  const workspaceId = p.workspaceId;
  if (!Array.isArray(args.facts) || args.facts.length === 0) {
    throw new ApiError(400, 'invalid_request', 'At least one fact must be attested.');
  }
  const aliases = blindAliases(workspaceId, args.aliases, strengths);

  for (const f of args.facts) {
    if (typeof f?.fact !== 'string' || !FACT_NAME.test(f.fact)) {
      throw new ApiError(400, 'invalid_request', `Fact name ${JSON.stringify(f?.fact)} is not usable.`);
    }
    if (!(FACT_TYPES as readonly string[]).includes(f.type)) {
      throw new ApiError(400, 'invalid_request',
        `Fact "${f.fact}" must declare a type of: ${FACT_TYPES.join(', ')}.`);
    }
    const t = typeof f.value;
    const want = f.type === 'bool' ? 'boolean' : f.type === 'str' ? 'string' : 'number';
    if (t !== want) {
      throw new ApiError(400, 'invalid_request',
        `Fact "${f.fact}" is declared ${f.type} but carries a ${t}.`, { fact: f.fact });
    }
    // Only the numeric types. `bool` also fails `type !== 'str'`, and an
    // earlier version of this line rejected every `false` in the system.
    if ((f.type === 'int' || f.type === 'time') && !Number.isSafeInteger(f.value as number)) {
      throw new ApiError(400, 'invalid_request',
        `Fact "${f.fact}" must be a safe integer; floats make equality a lie.`, { fact: f.fact });
    }
    if (f.type === 'str' && (f.value as string).length > MAX_STRING) {
      throw new ApiError(400, 'invalid_request', `Fact "${f.fact}" exceeds ${MAX_STRING} characters.`);
    }
  }

  return withTx(async (tx) => {
    const { subjectId } = await resolveForWrite(tx, workspaceId, aliases,
      { doing: 'attesting a fact' });

    // A closed catalogue admits only what it names, at the declared type and
    // within the declared values. An open one admits anything, as before.
    const catalogue = await loadCatalogue(tx, workspaceId);
    assertCatalogued(catalogue, args.facts.map((f) => f.fact), 'an attestation');
    for (const f of args.facts) assertAttestable(catalogue, f.fact, f.type, f.value);

    // A declared cohort may not be attested as a fact. The guarantee cohorts
    // rest on is that they cannot reach the grammar, and a fact can — so the
    // two namespaces are kept disjoint in both directions, here and in
    // `declareCohort`. Checked once for the whole batch.
    const { rows: cohorts } = await tx.query<{ cohort: string }>(
      `SELECT cohort FROM cohort_types
        WHERE workspace_id = $1 AND cohort = ANY($2::text[])`,
      [workspaceId, args.facts.map((f) => f.fact)]);
    if (cohorts[0]) {
      throw new ApiError(409, 'fact_is_a_cohort',
        `"${cohorts[0].cohort}" is a declared cohort in this workspace. Attesting it as a fact `
        + 'would let it appear in a rule, and a cohort must never decide about a person.',
        { name: cohorts[0].cohort });
    }

    for (const f of args.facts) {
      const { rows: src } = await tx.query<{ admissibility: string }>(
        'SELECT admissibility FROM fact_sources WHERE workspace_id = $1 AND source = $2',
        [workspaceId, f.source]);
      const admissibility = src[0]?.admissibility;
      if (admissibility === undefined) {
        throw new ApiError(400, 'unknown_source',
          `Source "${f.source}" is not declared in this workspace. Declare it with an `
          + 'admissibility class first — an undeclared source has no weight to assign.',
          { source: f.source });
      }
      await tx.query(
        `INSERT INTO attestations
           (workspace_id, subject_id, fact, fact_type, bool_value, int_value, str_value,
            source, admissibility, asserted_at, expires_at, attester)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (workspace_id, subject_id, fact) DO UPDATE SET
           fact_type = EXCLUDED.fact_type, bool_value = EXCLUDED.bool_value,
           int_value = EXCLUDED.int_value, str_value = EXCLUDED.str_value,
           source = EXCLUDED.source, admissibility = EXCLUDED.admissibility,
           asserted_at = EXCLUDED.asserted_at, expires_at = EXCLUDED.expires_at,
           received_at = now(), attester = EXCLUDED.attester`,
        [workspaceId, subjectId, f.fact, f.type,
          f.type === 'bool' ? f.value : null,
          f.type === 'int' || f.type === 'time' ? f.value : null,
          f.type === 'str' ? f.value : null,
          f.source, admissibility, f.assertedAt ?? new Date(), f.expiresAt ?? null,
          // The credential that asserted it. Not a person's name — the key the
          // institution issued, which is what it can be held to.
          p.keyId]);
    }
    // What makes correction prompt rather than eventual: without it, a
    // determination whose facts just changed waits its turn behind every other
    // open determination in the workspace. Keyed by subject rather than by
    // which facts each rule reads — a subject has few determinations, and
    // re-evaluating one whose inputs did not move is idempotent and cheap.
    await markDue(tx, workspaceId, subjectId);
    // And, for the handful this write can reach, correct them now: the fact
    // and its consequence commit together. The sweep takes whatever is left.
    await reexecuteSubject(tx, workspaceId, subjectId);

    return { subjectId, count: args.facts.length };
  });
}

/**
 * Erasure. A DELETE, because the historical value was never stored.
 *
 * Seals keep only digests, so this destroys nothing load-bearing and every
 * existing proof still verifies for anyone who holds the value. What it does
 * cost is re-evaluation: a seal whose facts are gone can no longer be re-run,
 * so it will read UNKNOWN and become `tainted` rather than silently lapsing.
 * That is the correct outcome — losing the ability to check is not the same as
 * discovering you were wrong.
 */
export async function eraseSubject(workspaceId: string, subjectId: string): Promise<number> {
  return withTx(async (tx) => {
    const { rowCount } = await tx.query(
      'DELETE FROM attestations WHERE workspace_id = $1 AND subject_id = $2',
      [workspaceId, subjectId]);
    // Erasure moves the ground more completely than any attestation — it
    // removes it. Every determination resting on these facts is now
    // unverifiable and must become `tainted` promptly rather than whenever the
    // cursor comes round, because an erasure is a legal event with a clock on it.
    await markDue(tx, workspaceId, subjectId);
    await reexecuteSubject(tx, workspaceId, subjectId);
    // Cohort membership is personal data about the same subject, and it is not
    // reachable through any read path — which makes it exactly the kind of row
    // an erasure quietly leaves behind. It goes with the attestations.
    await tx.query(
      'DELETE FROM subject_cohorts WHERE workspace_id = $1 AND subject_id = $2',
      [workspaceId, subjectId]);
    // A clock is about a person's application. The finding it produced is
    // about the agency, carries no subject, and stays.
    await tx.query('DELETE FROM clocks WHERE workspace_id = $1 AND subject_id = $2',
      [workspaceId, subjectId]);
    return rowCount ?? 0;
  });
}
