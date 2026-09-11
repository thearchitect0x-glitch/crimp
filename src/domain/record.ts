// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The examiner's artifact, and the disclosure that is itself on the record.
 *
 * The product's central claim is that an examiner can re-run a sealed rule
 * years later and get the identical answer. That claim was untestable from
 * outside: there was no way to get the rule, its hash, the grammar it was
 * evaluated under, and the digests it rested on, out of the system. A
 * reproducibility promise with no export is a promise nobody can call in.
 *
 * WHAT A PROOF CONTAINS AND WHAT IT DOES NOT. The rule as written, its
 * canonical hash, the grammar version, the reason set, and for every fact the
 * seal read: its name, type, source, admissibility, when it was asserted, and
 * `sha256(canonicalize({t, v}))` of the value. NOT the value. An examiner
 * holding the institution's own records recomputes the digest, compares, and
 * re-runs the rule; Crimp never held the value to leak.
 *
 * WHY DISCLOSURE IS A SEPARATE, RECORDED ACT. See `explain.ts` — the short
 * version is that the specificity a regulator requires and the probe an
 * adversary runs are the same request, so it is answered under authority and
 * written down rather than refused or handed out.
 */
import { withTx, getPool, type Db } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { rankOf } from './authority.js';
import { requireScope, type Principal } from './auth.js';
import { disclose, type DisclosedReason, type Reason } from './explain.js';
import type { Disposition } from './seal.js';
import type { Facts, Fact, FactType, Rule } from './rule.js';
import { fromStored, type RuleRef, type StoredRuleRef } from './registry.js';
import type { Remedy } from './remedy.js';
import type { Signature, SignaturePq } from '../lib/signing.js';
import { toStored } from './registry.js';

/** Reading the values that decided a determination is an operator act. */
export const DISCLOSURE_AUTHORITY = 'operator';

export interface SealedFact {
  fact: string;
  factType: FactType;
  /** sha256(canonicalize({ t: factType, v: value })). The value itself is nowhere. */
  valueSha256: string;
  source: string;
  admissibility: string;
  assertedAt: Date;
  /** The credential that asserted it, as the issuer identifies it. Null before cap-01. */
  attester: string | null;
}

export interface SealEvent {
  kind: string;
  actor: string | null;
  evidenceSha256: string | null;
  evidenceClass: string | null;
  occurredAt: Date;
}

export interface Proof {
  sealId: string;
  scope: string;
  disposition: Disposition;
  state: string;
  rule: Rule;
  ruleHash: string;
  grammarVersion: string;
  sealedBy: string;
  sealedAt: Date;
  expiresAt: Date | null;
  /** The date the decision is about (SPEC §7.0a). Null means as of `sealedAt`. */
  asOf: Date | null;
  /** The registered rule this was sealed under, if any. A citation, not a pointer. */
  ruleRef: RuleRef | null;
  /** What would move this the person's way (SPEC §7.0d). Null before cap-02 and on a commit. */
  remedy: Remedy | null;
  /** When a ruling elsewhere put this under review (SPEC §7.0e). Null if never. */
  reviewFlaggedAt: Date | null;
  /** The issuer's Ed25519 signature over `recordCore` (SPEC §7.0f). Null if unsigned. */
  signature: Signature | null;
  /** The issuer's ML-DSA-65 signature over the same core, when issued. Null if not. */
  signaturePq: SignaturePq | null;
  reasons: Reason[];
  facts: SealedFact[];
  events: SealEvent[];
  /** How to check this without trusting Crimp. */
  verify: {
    ruleHash: string;
    valueDigest: string;
    ruleRef: string;
    signature: string;
    signaturePq: string;
    note: string;
  };
}

interface SealRow {
  id: string; scope: string; disposition: Disposition; state: string; rule: Rule;
  rule_hash: string; grammar_version: string; sealed_by: string; sealed_at: Date;
  expires_at: Date | null; reasons: Reason[]; subject_id: string;
  as_of: Date | null; rule_ref: StoredRuleRef | null; remedy: Remedy | null;
  review_flagged_at: Date | null; signature: Signature | null; signature_pq: SignaturePq | null;
}

async function loadSeal(db: Db, workspaceId: string, sealId: string): Promise<SealRow> {
  const { rows } = await db.query<SealRow>(
    `SELECT id, scope, disposition, state, rule, rule_hash, grammar_version, sealed_by,
            sealed_at, expires_at, reasons, subject_id, as_of, rule_ref, remedy, review_flagged_at,
            signature, signature_pq
       FROM seals WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, sealId]);
  const seal = rows[0];
  if (seal === undefined) {
    // A cross-tenant read is a 404, never a hint that the record exists
    // elsewhere. Same rule as everywhere else in this codebase.
    throw new ApiError(404, 'not_found', 'No such determination.');
  }
  return seal;
}

/**
 * Everything an examiner needs, and nothing that identifies a person.
 *
 * Note what is absent: the subject id. A proof is about a determination, not
 * about a person, and handing back the internal identity key would make this
 * endpoint a way to enumerate one workspace's subjects.
 */
export async function proof(p: Principal, sealId: string): Promise<Proof> {
  requireScope(p, 'seals:read');
  return loadProof(getPool(), p.workspaceId, sealId);
}

/**
 * The signed core (SPEC §7.0f): what was decided, under which rule, on
 * which digests, with which reasons and remedy. Wire-shaped, because the
 * record format IS the wire shape and a verifier reconstructs exactly this
 * from the record. Nothing that moves — no state, no events, no flag.
 */
export function recordCore(p: Proof): Record<string, unknown> {
  return {
    seal_id: p.sealId,
    scope: p.scope,
    disposition: p.disposition,
    rule: p.rule,
    rule_hash: p.ruleHash,
    grammar_version: p.grammarVersion,
    sealed_by: p.sealedBy,
    sealed_at: p.sealedAt.toISOString(),
    expires_at: p.expiresAt?.toISOString() ?? null,
    as_of: p.asOf?.toISOString() ?? null,
    rule_ref: p.ruleRef === null ? null : toStored(p.ruleRef),
    reasons: p.reasons.map((r) => ({ path: r.path, fact: r.fact, op: r.op, value: r.value, truth: r.truth,
      polarity: r.polarity })),
    facts: p.facts.map((f) => ({ fact: f.fact, fact_type: f.factType, value_sha256: f.valueSha256,
      source: f.source, admissibility: f.admissibility, asserted_at: f.assertedAt.toISOString(),
      attester: f.attester })),
    remedy: p.remedy === null ? null : {
      target: p.remedy.target, exhaustive: p.remedy.exhaustive, evaluations: p.remedy.evaluations,
      sets: p.remedy.sets.map((set) => set.map((c) => ({ fact: c.fact, fact_type: c.factType,
        constraints: c.constraints.map((k) => ({ path: k.path, op: k.op, value: k.value, truth: k.truth })) }))),
    },
  };
}

/** Everything an examiner needs, on any connection — the seal path signs inside its transaction. */
export async function loadProof(db: Db, workspaceId: string, sealId: string): Promise<Proof> {
  const seal = await loadSeal(db, workspaceId, sealId);

  const { rows: facts } = await db.query<{
    fact: string; fact_type: FactType; value_sha256: string;
    source: string; admissibility: string; asserted_at: Date; attester: string | null;
  }>(
    `SELECT fact, fact_type, value_sha256, source, admissibility, asserted_at, attester
       FROM seal_facts WHERE seal_id = $1 ORDER BY fact`, [sealId]);

  const { rows: events } = await db.query<{
    kind: string; actor: string | null; evidence_sha256: string | null;
    evidence_class: string | null; occurred_at: Date;
  }>(
    `SELECT kind, actor, evidence_sha256, evidence_class, occurred_at
       FROM seal_events WHERE seal_id = $1 ORDER BY occurred_at, id`, [sealId]);

  return {
    sealId: seal.id,
    scope: seal.scope,
    disposition: seal.disposition,
    state: seal.state,
    rule: seal.rule,
    ruleHash: seal.rule_hash,
    grammarVersion: seal.grammar_version,
    sealedBy: seal.sealed_by,
    sealedAt: seal.sealed_at,
    expiresAt: seal.expires_at,
    asOf: seal.as_of,
    ruleRef: seal.rule_ref === null ? null : fromStored(seal.rule_ref),
    remedy: seal.remedy,
    reviewFlaggedAt: seal.review_flagged_at,
    signature: seal.signature,
    signaturePq: seal.signature_pq,
    reasons: seal.reasons,
    facts: facts.map((f) => ({
      fact: f.fact, factType: f.fact_type, valueSha256: f.value_sha256,
      source: f.source, admissibility: f.admissibility, assertedAt: f.asserted_at,
      attester: f.attester,
    })),
    events: events.map((e) => ({
      kind: e.kind, actor: e.actor, evidenceSha256: e.evidence_sha256,
      evidenceClass: e.evidence_class, occurredAt: e.occurred_at,
    })),
    // Stated in the artifact itself rather than in documentation somebody has
    // to still be hosting in 2032. A proof that does not say how to check it
    // is a proof that will not be checked.
    verify: {
      ruleHash: 'sha256(canonical JSON of `rule`: object keys sorted, '
        + 'commutative children of all/any sorted by their canonical form)',
      valueDigest: 'sha256(canonical JSON of {"t": fact_type, "v": value})',
      ruleRef: 'if present, rule_ref.version MUST equal rule_hash. Nothing else about it is '
        + 'verifiable without the institution\'s own registry, and the record does not depend on it.',
      signature: 'if present, Ed25519 over the canonical JSON (keys sorted, strings NFC) of the sealed '
        + 'core — seal_id, scope, disposition, rule, rule_hash, grammar_version, sealed_by, sealed_at, '
        + 'expires_at, as_of, rule_ref, reasons, facts, remedy — under the key published at '
        + '/.well-known/crimp-keys.json for its kid.',
      signaturePq: 'if present, ML-DSA-65 (FIPS 204) over the same canonical bytes, under the ml-dsa-65 key '
        + 'published for its kid (public_key is SubjectPublicKeyInfo DER, base64). The signature that '
        + 'survives a quantum computer. Absent means not issued, never invalid.',
      note: 'Recompute each value digest from your own record of the value, compare, then '
        + 're-run `rule` under grammar_version. Crimp never held the values, so it cannot '
        + 'have altered them.',
    },
  };
}

export interface Disclosure {
  sealId: string;
  reasons: DisclosedReason[];
  /** The event id this disclosure was recorded as. Asking why is on the record. */
  recordedAt: Date;
}

/**
 * The reasons, with the values that produced them — recorded.
 *
 * VALUES COME FROM CURRENT ATTESTATIONS, not from the seal, and that is not a
 * shortcut. The seal holds digests by design, so the historical value is not
 * recoverable from anywhere in this system. Each returned reason therefore
 * carries the digest comparison too: `matchesSeal` says whether the value
 * being disclosed is the one the determination actually rested on. A notice
 * built on a fact that has since changed is a different statement, and saying
 * so is the honest behaviour.
 */
export async function disclosure(p: Principal, sealId: string): Promise<Disclosure> {
  requireScope(p, 'seals:disclose');
  if (rankOf(p.authority) < rankOf(DISCLOSURE_AUTHORITY)) {
    throw new ApiError(403, 'insufficient_authority',
      `Disclosing the values behind a determination requires ${DISCLOSURE_AUTHORITY} `
      + `authority; this key is ${p.authority}. The values are what turn threshold `
      + 'discovery from a search into a single call.',
      { required: DISCLOSURE_AUTHORITY, held: p.authority });
  }

  return withTx(async (tx) => {
    const seal = await loadSeal(tx, p.workspaceId, sealId);
    const names = [...new Set(seal.reasons.map((r) => r.fact))];

    const { rows } = await tx.query<{
      fact: string; fact_type: FactType; bool_value: boolean | null;
      int_value: string | number | null; str_value: string | null;
      source: string; admissibility: string;
    }>(
      `SELECT fact, fact_type, bool_value, int_value, str_value, source, admissibility
         FROM attestations
        WHERE workspace_id = $1 AND subject_id = $2 AND fact = ANY($3::text[])`,
      [p.workspaceId, seal.subject_id, names]);

    const facts: Record<string, Fact> = {};
    const provenance: Record<string, { source: string; admissibility: string }> = {};
    for (const r of rows) {
      const value = r.fact_type === 'bool' ? r.bool_value!
        : r.fact_type === 'str' ? r.str_value! : Number(r.int_value);
      facts[r.fact] = { type: r.fact_type, value };
      provenance[r.fact] = { source: r.source, admissibility: r.admissibility };
    }

    const out = disclose(seal.reasons, facts as Facts, provenance);

    const { rows: rec } = await tx.query<{ occurred_at: Date }>(
      `INSERT INTO seal_events (seal_id, workspace_id, kind, actor, detail)
       VALUES ($1,$2,'disclosed',$3,$4::jsonb) RETURNING occurred_at`,
      [sealId, p.workspaceId, p.authority,
        // What was revealed, never the values revealed. The record of a
        // disclosure must not become a second copy of the disclosure.
        JSON.stringify({ facts: names, key_id: p.keyId })]);

    return { sealId, reasons: out, recordedAt: rec[0]!.occurred_at };
  });
}

/** Every disclosure made in this workspace. Who asked why, and when. */
export async function disclosures(
  p: Principal, days = 90,
): Promise<Array<{ sealId: string; actor: string; facts: string[]; occurredAt: Date }>> {
  requireScope(p, 'insight:read');
  const { rows } = await getPool().query<{
    seal_id: string; actor: string; detail: { facts: string[] }; occurred_at: Date;
  }>(
    `SELECT seal_id, actor, detail, occurred_at FROM seal_events
      WHERE workspace_id = $1 AND kind = 'disclosed'
        AND occurred_at > now() - ($2 || ' days')::interval
      ORDER BY occurred_at DESC LIMIT 500`,
    [p.workspaceId, String(days)]);
  return rows.map((r) => ({
    sealId: r.seal_id, actor: r.actor,
    facts: r.detail.facts ?? [], occurredAt: r.occurred_at,
  }));
}
