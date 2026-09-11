// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Phase 2 · The person's copy.
 *
 * Everything the system holds about one person, and only that person, in
 * one file they can keep and check themselves: their facts with the values
 * (they are the subject; the values are theirs to have), every
 * determination about them as a full record, their clocks, the issuer's
 * published keys, and the verifier — so the file verifies with nothing
 * from the issuer but the file.
 *
 * THIS IS A DISCLOSURE, and is recorded as one on every determination it
 * contains, for the same reason `disclosure()` is: the values behind a
 * refusal are what a person needs and what an adversary probes for, and the
 * answer to both is not to refuse but to write down who asked. Operator
 * authority, `seals:disclose`.
 *
 * WHAT IS NOT HERE. Other people. A subject's clocks and determinations are
 * theirs alone; findings carry no subject and belong to the institution;
 * the evaluation log carries no subject and is not about them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withTx } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { rankOf } from './authority.js';
import { requireScope, type Principal } from './auth.js';
import { resolveForRead, thresholdOf } from './subject.js';
import { blindAliases, mergeCapable, type MergeStrength } from '../lib/blind.js';
import { loadProof, recordCore, type Proof, DISCLOSURE_AUTHORITY } from './record.js';
import { signer } from './signer.js';
import type { FactType } from './rule.js';

export const PERSON_COPY_FORMAT = 'crimp-person-copy/1';

export interface PersonCopy {
  format: typeof PERSON_COPY_FORMAT;
  spec_version: string;
  generated_at: string;
  /** The aliases the requester presented, as presented. The person's own identifiers. */
  presented: unknown;
  facts: Array<{
    fact: string; type: FactType; value: boolean | number | string; source: string;
    admissibility: string; asserted_at: string; expires_at: string | null; attester: string | null;
  }>;
  determinations: Proof[];
  clocks: Array<{ clock: string; scope: string; status: string; started_at: string; due_at: string;
    met_at: string | null; missed_at: string | null; resolved_at: string | null }>;
  keys: Array<{ kid: string; alg: string; public_key: string; status: 'current' | 'previous' }>;
  verify: {
    how: string;
    /** The independent verifier, inline, so the copy checks itself with nothing else. */
    verifier_source: string;
    /** For each determination: the values above, keyed as the verifier expects. */
    held_values: Record<string, { type: FactType; value: boolean | number | string }>;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
let verifierSource: string | null = null;
function loadVerifier(): string {
  // dist/domain → ../../spec ; src/domain → ../../spec. Same relative path.
  verifierSource ??= readFileSync(join(here, '..', '..', 'spec', 'verifier.mjs'), 'utf8');
  return verifierSource;
}

export async function personCopy(
  p: Principal, args: { aliases: unknown }, strengths: Readonly<Record<string, MergeStrength>>,
): Promise<PersonCopy> {
  requireScope(p, 'seals:disclose');
  if (rankOf(p.authority) < rankOf(DISCLOSURE_AUTHORITY)) {
    throw new ApiError(403, 'insufficient_authority',
      `A person's copy discloses the values behind every determination about them and requires `
      + `${DISCLOSURE_AUTHORITY} authority; this key is ${p.authority}.`,
      { required: DISCLOSURE_AUTHORITY, held: p.authority });
  }
  const aliases = blindAliases(p.workspaceId, args.aliases, strengths);

  return withTx(async (tx) => {
    // The most sensitive read in the system resolves identity from
    // IDENTITY-GRADE aliases only. A phone or an email is routinely shared
    // and, bound first-writer-wins, would hand one person another's income.
    // And it is a read: `resolveForRead` attaches nothing. Both found by the
    // security sweep.
    const capable = mergeCapable(aliases, await thresholdOf(tx, p.workspaceId));
    if (capable.length === 0) {
      throw new ApiError(400, 'identity_required',
        'A person\'s copy is issued only against an identity-grade identifier (one the workspace declares '
        + 'merge-capable). A shared phone or email cannot say whose copy this is.',
        { presented: aliases.map((a) => a.type) });
    }
    const subjectId = await resolveForRead(tx, p.workspaceId, capable);
    if (subjectId === null) {
      throw new ApiError(404, 'unknown_subject', 'No subject matches these identifiers.');
    }

    const { rows: facts } = await tx.query<{
      fact: string; fact_type: FactType; bool_value: boolean | null; int_value: string | number | null;
      str_value: string | null; source: string; admissibility: string; asserted_at: Date;
      expires_at: Date | null; attester: string | null;
    }>(
      `SELECT fact, fact_type, bool_value, int_value, str_value, source, admissibility, asserted_at, expires_at, attester
         FROM attestations WHERE workspace_id = $1 AND subject_id = $2 ORDER BY fact`,
      [p.workspaceId, subjectId]);
    const held: PersonCopy['verify']['held_values'] = {};
    const factsOut: PersonCopy['facts'] = facts.map((r) => {
      const value = r.fact_type === 'bool' ? r.bool_value! : r.fact_type === 'str' ? r.str_value! : Number(r.int_value);
      held[r.fact] = { type: r.fact_type, value };
      return { fact: r.fact, type: r.fact_type, value, source: r.source, admissibility: r.admissibility,
        asserted_at: r.asserted_at.toISOString(), expires_at: r.expires_at?.toISOString() ?? null, attester: r.attester };
    });

    const { rows: seals } = await tx.query<{ id: string }>(
      'SELECT id FROM seals WHERE workspace_id = $1 AND subject_id = $2 ORDER BY sealed_at', [p.workspaceId, subjectId]);
    const determinations: Proof[] = [];
    for (const s of seals) {
      const pr = await loadProof(tx, p.workspaceId, s.id);
      // On the record: this person's copy disclosed the values behind this
      // determination, to whoever holds this key. Same event as disclosure().
      await tx.query(
        `INSERT INTO seal_events (seal_id, workspace_id, kind, actor, detail)
         VALUES ($1,$2,'disclosed',$3,$4::jsonb)`,
        [s.id, p.workspaceId, p.authority,
          JSON.stringify({ facts: pr.facts.map((f) => f.fact), key_id: p.keyId, person_copy: true })]);
      determinations.push(pr);
    }

    const { rows: clocks } = await tx.query<{
      name: string; scope: string; status: string; started_at: Date; due_at: Date;
      met_at: Date | null; missed_at: Date | null; resolved_at: Date | null;
    }>(
      `SELECT name, scope, status, started_at, due_at, met_at, missed_at, resolved_at
         FROM clocks WHERE workspace_id = $1 AND subject_id = $2 ORDER BY started_at`, [p.workspaceId, subjectId]);

    const sg = signer();
    void recordCore;
    return {
      format: PERSON_COPY_FORMAT,
      spec_version: '0.2',
      generated_at: new Date().toISOString(),
      presented: args.aliases,
      facts: factsOut,
      determinations,
      clocks: clocks.map((c) => ({ clock: c.name, scope: c.scope, status: c.status,
        started_at: c.started_at.toISOString(), due_at: c.due_at.toISOString(),
        met_at: c.met_at?.toISOString() ?? null, missed_at: c.missed_at?.toISOString() ?? null,
        resolved_at: c.resolved_at?.toISOString() ?? null })),
      keys: sg === null ? [] : sg.publishedKeys(),
      verify: {
        how: 'Save verifier_source as verifier.mjs. For each determination, save it as record.json, '
          + 'held_values as values.json and keys as keys.json, then: node verify-cli.mjs record.json '
          + '--values values.json --keys keys.json (verify-cli.mjs is in the same specification '
          + 'bundle). Every step that can run must pass.',
        verifier_source: loadVerifier(),
        held_values: held,
      },
    };
  });
}
