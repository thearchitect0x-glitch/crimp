// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
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
import { FACT_TYPES, type FactType } from './rule.js';

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

export async function attest(args: {
  workspaceId: string;
  aliases: unknown;
  facts: readonly AttestInput[];
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<{ subjectId: string; count: number }> {
  if (!Array.isArray(args.facts) || args.facts.length === 0) {
    throw new ApiError(400, 'invalid_request', 'At least one fact must be attested.');
  }
  const aliases = blindAliases(args.workspaceId, args.aliases, strengths);

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
    const { rows: existing } = await tx.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM subject_aliases
        WHERE workspace_id = $1 AND (alias_type, blinded) IN (
          SELECT * FROM UNNEST($2::text[], $3::text[]))`,
      [args.workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded)]);
    if (existing.length > 1) {
      throw new ApiError(409, 'merge_required',
        'These aliases identify several subjects; resolve the merge before attesting.');
    }

    let subjectId = existing[0]?.subject_id;
    if (subjectId === undefined) {
      subjectId = `sub_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
      await tx.query('INSERT INTO subjects (id, workspace_id) VALUES ($1,$2)',
        [subjectId, args.workspaceId]);
    }
    await tx.query(
      `INSERT INTO subject_aliases (workspace_id, alias_type, blinded, subject_id, merge_strength)
       SELECT $1, t, b, $4, s FROM UNNEST($2::text[], $3::text[], $5::text[]) AS u(t,b,s)
       ON CONFLICT (workspace_id, alias_type, blinded) DO NOTHING`,
      [args.workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded), subjectId,
        aliases.map((a) => a.strength)]);

    for (const f of args.facts) {
      const { rows: src } = await tx.query<{ admissibility: string }>(
        'SELECT admissibility FROM fact_sources WHERE workspace_id = $1 AND source = $2',
        [args.workspaceId, f.source]);
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
            source, admissibility, asserted_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (workspace_id, subject_id, fact) DO UPDATE SET
           fact_type = EXCLUDED.fact_type, bool_value = EXCLUDED.bool_value,
           int_value = EXCLUDED.int_value, str_value = EXCLUDED.str_value,
           source = EXCLUDED.source, admissibility = EXCLUDED.admissibility,
           asserted_at = EXCLUDED.asserted_at, expires_at = EXCLUDED.expires_at,
           received_at = now()`,
        [args.workspaceId, subjectId, f.fact, f.type,
          f.type === 'bool' ? f.value : null,
          f.type === 'int' || f.type === 'time' ? f.value : null,
          f.type === 'str' ? f.value : null,
          f.source, admissibility, f.assertedAt ?? new Date(), f.expiresAt ?? null]);
    }
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
    return rowCount ?? 0;
  });
}
