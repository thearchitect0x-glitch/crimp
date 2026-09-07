// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Seal, check, claw, re-evaluate.
 *
 * The agent never states an outcome. It submits the rule it is applying and
 * points at attested facts; this module evaluates the rule and derives the
 * disposition. There is no parameter through which a conclusion can arrive.
 */
import type pg from 'pg';
import { withTx, type Db } from '../db/pool.js';
import { newId, sha256Hex, canonicalize } from '../lib/ids.js';
import { ApiError } from '../lib/errors.js';
import { blindAliases, type MergeStrength, type BlindedAlias } from '../lib/blind.js';
import {
  validateRule, canonicalRule, factsReferenced,
  GRAMMAR_VERSION, SUPPORTED_GRAMMAR_VERSIONS,
  TRUE, FALSE, UNKNOWN,
  type Rule, type Facts, type Fact, type FactType,
} from './rule.js';
import { evaluate } from './evaluate.js';
import { validateScope, ancestors, covers } from './scope.js';
import {
  validateClawRule, mayClaw, isAuthority, type Authority, type ClawRule,
} from './authority.js';
import { meetsFloor, type Admissibility } from './admissibility.js';
import { requireScope, type Principal } from './auth.js';
import { classify, tierOf, harden, PRESSURE_WINDOW_DAYS, type Pressure } from './lifecycle.js';

export type Disposition = 'bind' | 'permit' | 'commit';

/**
 * Note what is absent: `workspaceId` and `sealedBy`.
 *
 * Both are properties of the credential and neither may be stated by a caller.
 * Every invariant here rests on authority being true, and an authority a
 * request can assert is not an authority.
 */
export interface SealInput {
  /**
   * Required, not optional.
   *
   * An at-most-once guarantee a caller can forget to opt into is not a
   * guarantee. A retried request replays the original determination rather
   * than creating a second one — which for a `permit` is the difference
   * between one grant and two.
   */
  idempotencyKey: string;
  aliases: unknown;
  scope: string;
  disposition: Disposition;
  rule: unknown;
  claw: ClawRule;
  maxUses?: number | null;
  /** When this determination stops standing on its own. Null means never. */
  expiresAt?: Date | null;
  /** Fact classes policy requires this effect type's rules to reference. */
  requiredFacts?: readonly string[];
}

export interface SealResult {
  sealId: string | null;
  /** `replayed` is a retry finding its own earlier determination, not a new one. */
  outcome: 'sealed' | 'not_applicable' | 'replayed';
  disposition: Disposition;
  ruleHash: string;
  reason: string;
}

/* ── Subject resolution ──────────────────────────────────────────────── */

interface Resolved { subjectId: string; created: boolean }

/**
 * Find or create the subject these aliases identify.
 *
 * Handles the two unambiguous cases. When presented aliases already belong to
 * SEVERAL existing subjects, this refuses rather than guessing: unioning them
 * is monotone and therefore permanent, and a wrong permanent merge drags
 * strangers under somebody else's determination with no way back. The degree-
 * bounded merge with authority-signed carve-outs is its own piece of work and
 * gets its own tests; until it lands, failing closed and recording the refusal
 * is the only honest behaviour.
 */
async function resolveSubject(
  tx: pg.PoolClient, workspaceId: string, aliases: readonly BlindedAlias[],
): Promise<Resolved> {
  const { rows: existing } = await tx.query<{ subject_id: string }>(
    `SELECT DISTINCT subject_id FROM subject_aliases
      WHERE workspace_id = $1 AND (alias_type, blinded) IN (
        SELECT * FROM UNNEST($2::text[], $3::text[]))`,
    [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded)],
  );

  if (existing.length > 1) {
    throw new ApiError(409, 'merge_required',
      `These aliases already identify ${existing.length} distinct subjects. Unioning them is `
      + 'permanent and cannot be undone, so Crimp will not do it implicitly. Resolve the merge '
      + 'explicitly.', { subjects: existing.length });
  }

  const subjectId = existing[0]?.subject_id ?? newId('sub');
  const created = existing.length === 0;
  if (created) {
    await tx.query('INSERT INTO subjects (id, workspace_id) VALUES ($1, $2)', [subjectId, workspaceId]);
  }

  // Attach any aliases not already bound. Monotone: this only ever adds.
  await tx.query(
    `INSERT INTO subject_aliases (workspace_id, alias_type, blinded, subject_id, merge_strength)
     SELECT $1, t, b, $4, s FROM UNNEST($2::text[], $3::text[], $5::text[]) AS u(t, b, s)
     ON CONFLICT (workspace_id, alias_type, blinded) DO NOTHING`,
    [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded), subjectId,
      aliases.map((a) => a.strength)],
  );
  await tx.query(
    `UPDATE subjects SET alias_count =
       (SELECT count(*) FROM subject_aliases WHERE subject_id = $1) WHERE id = $1`,
    [subjectId]);

  return { subjectId, created };
}

/* ── Attested facts ──────────────────────────────────────────────────── */

interface FactRow {
  fact: string; fact_type: FactType;
  bool_value: boolean | null; int_value: number | null; str_value: string | null;
  source: string; admissibility: Admissibility; asserted_at: Date;
}

function toFact(r: FactRow): Fact {
  switch (r.fact_type) {
    case 'bool': return { type: 'bool', value: r.bool_value as boolean };
    case 'int': case 'time': return { type: r.fact_type, value: r.int_value as number };
    case 'str': return { type: 'str', value: r.str_value as string };
  }
}

async function loadFacts(
  db: Db, workspaceId: string, subjectId: string, names: readonly string[],
): Promise<{ facts: Facts; rows: FactRow[] }> {
  if (names.length === 0) return { facts: {}, rows: [] };
  const { rows } = await db.query<FactRow>(
    // An expired attestation is not read. The customer declared when it stops
    // being current, and ignoring that declaration meant determinations rested
    // on facts their own owner had marked stale.
    //
    // The consequence is exactly right and is the reason this is a filter
    // rather than a warning: an absent fact is UNKNOWN, never false. A rule
    // reading a lapsed attestation is therefore unanswered rather than
    // violated, a determination resting on one becomes `tainted` rather than
    // silently re-decided, and a fresh seal is refused with `facts_not_attested`.
    // That is 42 CFR 435.916 in one clause — if the data on hand is stale you
    // may not determine from it, you must go and ask.
    `SELECT fact, fact_type, bool_value, int_value, str_value, source, admissibility, asserted_at
       FROM attestations
      WHERE workspace_id = $1 AND subject_id = $2 AND fact = ANY($3::text[])
        AND (expires_at IS NULL OR expires_at > now())`,
    [workspaceId, subjectId, names],
  );
  const facts: Record<string, Fact> = {};
  for (const r of rows) facts[r.fact] = toFact(r);
  return { facts, rows };
}

/** The commitment recorded against a seal. The raw historical value is never stored. */
function valueDigest(r: FactRow): string {
  const raw = r.fact_type === 'bool' ? r.bool_value
    : r.fact_type === 'str' ? r.str_value : r.int_value;
  return sha256Hex(canonicalize({ t: r.fact_type, v: raw }));
}

/* ── Seal ────────────────────────────────────────────────────────────── */

export async function seal(
  p: Principal, input: SealInput, strengths: Readonly<Record<string, MergeStrength>>,
): Promise<SealResult> {
  requireScope(p, 'seals:write');
  const workspaceId = p.workspaceId;
  const sealedBy = p.authority;
  const scope = validateScope(input.scope);
  if (!['bind', 'permit', 'commit'].includes(input.disposition)) {
    throw new ApiError(400, 'invalid_request', 'disposition must be bind, permit or commit.');
  }
  if (input.maxUses != null && input.disposition !== 'permit') {
    throw new ApiError(400, 'invalid_request', 'max_uses applies only to a permit.');
  }
  if (typeof input.idempotencyKey !== 'string'
      || !/^[\w.:-]{1,128}$/.test(input.idempotencyKey)) {
    throw new ApiError(400, 'invalid_request',
      'idempotency_key is required: 1 to 128 characters of letters, digits, '
      + '. : _ or -. A retry without one creates a second determination.');
  }
  if (input.expiresAt != null) {
    if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
      throw new ApiError(400, 'invalid_request', 'expires_at must be a timestamp.');
    }
    // A determination that is born expired binds nothing, and the caller is
    // told it was sealed. That is the same silent failure as an unparseable
    // expiry, and it is nearly always a unit or timezone mistake rather than
    // an intention. Refuse it while somebody is still looking at the response.
    if (input.expiresAt.getTime() <= Date.now()) {
      throw new ApiError(400, 'expiry_in_the_past',
        'expires_at is already past, so this determination would bind nothing while reporting '
        + 'itself sealed. Check the units and the timezone.',
        { expiresAt: input.expiresAt.toISOString() });
    }
  }
  const clawRule = validateClawRule(sealedBy, input.claw);
  const referenced = validateRule(input.rule);
  const rule = input.rule as Rule;

  // A rule that references none of the fact classes policy requires is a rule
  // that decides nothing while looking like it decides something — the vacuous
  // rule an agent would author to reach a foregone conclusion.
  for (const required of input.requiredFacts ?? []) {
    if (!referenced.has(required)) {
      throw new ApiError(400, 'rule_missing_required_fact',
        `Policy requires a rule in scope "${scope}" to reference "${required}".`,
        { required, referenced: [...referenced] });
    }
  }

  const ruleHash = sha256Hex(canonicalRule(rule));
  const aliases = blindAliases(workspaceId, input.aliases, strengths);

  return withTx(async (tx) => {
    // Replay before doing any work. A retry must be cheap and must not
    // re-resolve subjects or re-evaluate anything.
    const { rows: prior } = await tx.query<{
      id: string; disposition: Disposition; rule_hash: string;
    }>(`SELECT id, disposition, rule_hash FROM seals
         WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, input.idempotencyKey]);
    if (prior[0]) {
      if (prior[0].rule_hash !== ruleHash) {
        throw new ApiError(409, 'idempotency_key_reuse',
          'This idempotency key was already used for a different rule. Reusing one '
          + 'across different determinations would make the first unfindable.',
          { idempotencyKey: input.idempotencyKey });
      }
      return {
        sealId: prior[0].id, outcome: 'replayed' as const,
        disposition: prior[0].disposition, ruleHash,
        reason: 'This determination already exists. Returning the original.',
      };
    }

    const { subjectId } = await resolveSubject(tx, workspaceId, aliases);
    const { facts, rows } = await loadFacts(tx, workspaceId, subjectId, [...referenced]);

    // Throws RuleTypeError (400) on a literal that cannot be compared with the
    // fact it names. That is a bug in the rule, not missing data, and it must
    // be refused loudly rather than absorbed as UNKNOWN.
    const truth = evaluate(rule, facts);

    if (truth === UNKNOWN) {
      const missing = [...referenced].filter((f) => facts[f] === undefined);
      throw new ApiError(409, 'facts_not_attested',
        'This rule reads facts that have not been attested, so it has not been answered — it has '
        + 'neither been satisfied nor violated. Attest them and seal again. An agent may not '
        + 'decide on facts it never gathered.', { missing });
    }

    if (truth === FALSE) {
      // Not an error. The agent applied its rule and the rule did not hold, so
      // no determination exists. Recorded nowhere as a seal, returned plainly.
      return {
        sealId: null, outcome: 'not_applicable' as const,
        disposition: input.disposition, ruleHash,
        reason: 'The rule did not hold against the attested facts. No determination was created.',
      };
    }

    const sealId = newId('seal');
    await tx.query(
      `INSERT INTO seals (id, workspace_id, subject_id, scope, disposition, rule, rule_hash,
                          grammar_version, sealed_by, claw_authority, claw_evidence_floor,
                          claw_cooling_off_s, max_uses, idempotency_key, expires_at,
                          last_evaluated_at, evaluation_due)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),false)`,
      [sealId, workspaceId, subjectId, scope, input.disposition, JSON.stringify(rule),
        ruleHash, GRAMMAR_VERSION, sealedBy, clawRule.authority, clawRule.evidenceFloor,
        clawRule.coolingOffSeconds, input.maxUses ?? null,
        input.idempotencyKey, input.expiresAt ?? null],
    );

    for (const r of rows) {
      await tx.query(
        `INSERT INTO seal_facts (seal_id, fact, fact_type, value_sha256, source, admissibility, asserted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sealId, r.fact, r.fact_type, valueDigest(r), r.source, r.admissibility, r.asserted_at],
      );
    }

    await tx.query(
      `INSERT INTO seal_events (seal_id, workspace_id, kind, actor, detail)
       VALUES ($1,$2,'sealed',$3,$4::jsonb)`,
      [sealId, workspaceId, sealedBy,
        JSON.stringify({ scope, disposition: input.disposition, rule_hash: ruleHash })],
    );

    return {
      sealId, outcome: 'sealed' as const, disposition: input.disposition, ruleHash,
      reason: 'The rule held. The determination is sealed.',
    };
  });
}

/* ── Lookup: a query, not a gate ─────────────────────────────────────── */

/**
 * One standing determination about a subject.
 *
 * WHY THIS IS A QUERY AND NOT AN AUTHORIZATION.
 *
 * Crimp holds no credentials, has no outbound access and executes nothing. It
 * cannot stop an action and never could. An earlier version of this returned
 * `{ bound: true|false }` and a scoped token for a downstream gate to require,
 * which described a system that does not exist here — and described, fairly
 * precisely, the pre-action authorization category that OPA, Cedar, the OAP
 * draft and at least one granted patent already occupy.
 *
 * What Crimp actually has that none of them do is the determination itself.
 * So it reports determinations and the caller decides. That is honest about
 * the boundary, and it makes Crimp compose with those gates rather than
 * duplicate them: they evaluate policy written in advance, and none of them
 * has a runtime determination to evaluate against.
 *
 * The distinction is not cosmetic. "You may not proceed" is a claim Crimp is
 * not entitled to make. "There is a standing refusal, sealed under this rule,
 * reversible only by this authority" is a fact it holds.
 */
export interface Determination {
  sealId: string;
  scope: string;
  disposition: Disposition;
  state: 'sealed' | 'tainted';
  /** Machine-readable; agents branch on this, never on prose. */
  code: string;
  /** `permit` only: uses remaining, or null when unbounded. */
  remaining?: number | null;
}

export interface LookupResult {
  /** Empty means nothing has been decided. It does not mean "allowed". */
  determinations: Determination[];
}

export const CODES = {
  refusalStanding: 'bind.refusal_standing',
  refusalTainted: 'bind.tainted',
  permitAvailable: 'permit.available',
  permitExhausted: 'permit.exhausted',
  commitMade: 'commit.made',
} as const;

/**
 * What has been determined about this subject in this scope?
 *
 * Reads. Does not consume a permit — an earlier version spent a use merely by
 * being asked, so a caller checking whether a one-time grant was available
 * destroyed it in the process. Spending is now an explicit act; see `exercise`.
 *
 * A standing refusal records pressure, which is the one write this path makes.
 * That is deliberate: refused attempts are the observable nothing else has, and
 * the whole product is downstream of counting them.
 */
export async function lookup(p: Principal, args: {
  aliases: unknown;
  scope: string;
  session?: string;
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<LookupResult> {
  requireScope(p, 'determinations:read');
  const workspaceId = p.workspaceId;
  const scope = validateScope(args.scope);
  const aliases = blindAliases(workspaceId, args.aliases, strengths);

  return withTx(async (tx) => {
    const { rows: sub } = await tx.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM subject_aliases
        WHERE workspace_id = $1 AND (alias_type, blinded) IN (
          SELECT * FROM UNNEST($2::text[], $3::text[]))`,
      [workspaceId, aliases.map((a) => a.type), aliases.map((a) => a.blinded)],
    );
    if (sub.length === 0) return { determinations: [] };
    if (sub.length > 1) {
      throw new ApiError(409, 'merge_required',
        'These aliases identify several subjects; resolve the merge before asking.',
        { subjects: sub.length });
    }
    const subjectId = sub[0]!.subject_id;

    const { rows: found } = await tx.query<{
      id: string; scope: string; disposition: Disposition; state: 'sealed' | 'tainted';
      max_uses: number | null; uses: number;
    }>(
      `SELECT id, scope, disposition, state, max_uses, uses
         FROM seals
        WHERE workspace_id = $1 AND subject_id = $2 AND scope = ANY($3::text[])
          AND state IN ('sealed', 'tainted')
          -- An expired determination stops standing the moment it expires,
          -- without waiting for a sweep to notice.
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY sealed_at`,
      [workspaceId, subjectId, ancestors(scope)],
    );

    const out: Determination[] = [];
    for (const s of found) {
      if (!covers(s.scope, scope)) continue;
      if (s.disposition === 'bind') {
        // A tainted bind still stands. Tainted means the ground is gone, not
        // that the claim was disproved, and lifting on an unknown is the guess
        // a gate must never make.
        await bumpPressure(tx, s.id, args.session);
        out.push({
          sealId: s.id, scope: s.scope, disposition: 'bind', state: s.state,
          code: s.state === 'tainted' ? CODES.refusalTainted : CODES.refusalStanding,
        });
      } else if (s.disposition === 'permit') {
        const remaining = s.max_uses === null ? null : s.max_uses - s.uses;
        out.push({
          sealId: s.id, scope: s.scope, disposition: 'permit', state: s.state,
          code: remaining !== null && remaining <= 0 ? CODES.permitExhausted : CODES.permitAvailable,
          remaining,
        });
      } else {
        out.push({
          sealId: s.id, scope: s.scope, disposition: 'commit', state: s.state,
          code: CODES.commitMade,
        });
      }
    }
    return { determinations: out };
  });
}

/**
 * Spend one use of a permit.
 *
 * Separate from `lookup` because it is a mutation and asking a question should
 * never cost you the answer. At-most-N is enforced by the database — the
 * conditional UPDATE returning zero rows IS the refusal — so two concurrent
 * callers cannot both win the last use.
 */
export async function exercise(p: Principal, args: { sealId: string })
: Promise<{ exercised: boolean; remaining: number | null; code: string }> {
  requireScope(p, 'permits:exercise');
  return withTx(async (tx) => {
    const { rows } = await tx.query<{
      disposition: Disposition; state: string; max_uses: number | null; uses: number;
    }>(
      `SELECT disposition, state, max_uses, uses FROM seals
        WHERE id = $1 AND workspace_id = $2`, [args.sealId, p.workspaceId]);
    const s = rows[0];
    if (!s) throw new ApiError(404, 'not_found', 'No such determination.');
    if (s.disposition !== 'permit') {
      throw new ApiError(409, 'not_a_permit',
        `Only a permit can be exercised; this determination is a ${s.disposition}.`);
    }
    if (s.state !== 'sealed' && s.state !== 'tainted') {
      throw new ApiError(409, 'already_settled', `This permit is ${s.state}.`);
    }

    const { rowCount } = await tx.query(
      `UPDATE seals SET uses = uses + 1
        WHERE id = $1 AND (max_uses IS NULL OR uses < max_uses)`, [args.sealId]);
    if (rowCount === 0) {
      return { exercised: false, remaining: 0, code: CODES.permitExhausted };
    }
    await tx.query(
      `INSERT INTO seal_events (seal_id, workspace_id, kind) VALUES ($1,$2,'exercised')`,
      [args.sealId, p.workspaceId]);
    return {
      exercised: true,
      remaining: s.max_uses === null ? null : s.max_uses - s.uses - 1,
      code: 'permit.exercised',
    };
  });
}

async function bumpPressure(tx: pg.PoolClient, sealId: string, session?: string): Promise<void> {
  // An absent session is still an attempt: it counts toward `attempts` and
  // contributes nothing to the distinct-session count, because an unidentified
  // caller is not evidence of a second caller. Marked out of band with
  // `declared` rather than by a reserved session value — a sentinel sharing a
  // value space with real data eventually collides with real data, and here
  // the collision would silently suppress the signal that triggers hardening.
  const declared = typeof session === 'string' && /^[0-9a-f]{32}$/.test(session);
  await tx.query(
    `INSERT INTO pressure (seal_id, session, declared, attempts) VALUES ($1,$2,$3,1)
     ON CONFLICT (seal_id, session)
     DO UPDATE SET attempts = pressure.attempts + 1, last_at = now()`,
    [sealId, declared ? session : '0'.repeat(32), declared]);
}

export async function pressureOf(db: Db, sealId: string): Promise<Pressure> {
  const { rows } = await db.query<{ attempts: string; sessions: string }>(
    `SELECT COALESCE(sum(attempts), 0) AS attempts,
            count(*) FILTER (WHERE declared) AS sessions
       FROM pressure
      WHERE seal_id = $1 AND last_at > now() - ($2 || ' days')::interval`,
    [sealId, String(PRESSURE_WINDOW_DAYS)]);
  const r = rows[0];
  return { attempts: Number(r?.attempts ?? 0), sessions: Number(r?.sessions ?? 0) };
}

/* ── Claw ────────────────────────────────────────────────────────────── */

export async function claw(p: Principal, args: {
  sealId: string;
  evidenceSha256: string;
  evidenceClass: Admissibility;
}): Promise<{ state: 'clawed' }> {
  requireScope(p, 'seals:claw');
  const workspaceId = p.workspaceId;
  const actor = p.authority;
  if (!/^[0-9a-f]{64}$/.test(args.evidenceSha256)) {
    throw new ApiError(400, 'invalid_request', 'evidence_sha256 must be 64 hex characters.');
  }

  return withTx(async (tx) => {
    const { rows } = await tx.query<{
      id: string; state: string; disposition: Disposition; sealed_at: Date;
      claw_authority: Authority; claw_evidence_floor: Admissibility; claw_cooling_off_s: number;
    }>(
      `SELECT id, state, disposition, sealed_at, claw_authority, claw_evidence_floor, claw_cooling_off_s
         FROM seals WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [args.sealId, workspaceId]);
    const s = rows[0];
    // A cross-tenant lookup is a 404, never a hint that the record exists elsewhere.
    if (!s) throw new ApiError(404, 'not_found', 'No such seal.');
    if (s.state === 'clawed' || s.state === 'lapsed') {
      throw new ApiError(409, 'already_settled', `This seal is already ${s.state}.`, { state: s.state });
    }

    // Pressure hardening is applied at reversal time rather than written into
    // the row, so it always reflects the current rolling window rather than a
    // snapshot taken when somebody happened to look.
    const base: ClawRule = {
      authority: s.claw_authority,
      evidenceFloor: s.claw_evidence_floor,
      coolingOffSeconds: s.claw_cooling_off_s,
    };
    const tier = tierOf(await pressureOf(tx, s.id));
    const { rule: required, hardened } = harden(s.disposition, base, tier);

    if (!mayClaw(actor, required.authority)) {
      throw new ApiError(403, 'insufficient_authority',
        `Reversing this determination requires "${required.authority}"; the caller is `
        + `"${actor}".${hardened ? ' This seal has hardened under sustained pressure.' : ''}`,
        { required: required.authority, actor, hardened, pressureTier: tier });
    }
    if (!meetsFloor(args.evidenceClass, required.evidenceFloor)) {
      throw new ApiError(403, 'insufficient_evidence',
        `Reversing this determination requires evidence of at least "${required.evidenceFloor}"; `
        + `"${args.evidenceClass}" does not meet it.`,
        { required: required.evidenceFloor, offered: args.evidenceClass, hardened });
    }

    const elapsed = (Date.now() - s.sealed_at.getTime()) / 1000;
    if (elapsed < required.coolingOffSeconds) {
      // The one defence immune to a perfectly persuasive argument: you cannot
      // talk time into passing.
      throw new ApiError(409, 'cooling_off',
        `This determination may not be reversed for another `
        + `${Math.ceil(required.coolingOffSeconds - elapsed)} seconds.`,
        { remainingSeconds: Math.ceil(required.coolingOffSeconds - elapsed) });
    }

    await tx.query(
      `UPDATE seals SET state = 'clawed', settled_at = now() WHERE id = $1`, [s.id]);
    await tx.query(
      `INSERT INTO seal_events (seal_id, workspace_id, kind, actor, evidence_sha256, evidence_class, detail)
       VALUES ($1,$2,'clawed',$3,$4,$5,$6::jsonb)`,
      [s.id, workspaceId, actor, args.evidenceSha256, args.evidenceClass,
        JSON.stringify({ hardened, pressure_tier: tier, required })]);

    return { state: 'clawed' as const };
  });
}

/* ── Re-evaluation ───────────────────────────────────────────────────── */

/**
 * The ground under this subject moved. Anything standing on it is due.
 *
 * ONE FUNCTION, CALLED FROM EVERY PLACE THAT MOVES GROUND — deliberately, and
 * the reason is a pattern this codebase keeps repeating. Four defects so far
 * have had the identical shape: a principle stated clearly, enforced on one
 * axis, silently unenforced on the neighbouring one. `mergeCapable()` was
 * written and never called. Cooling-off bounded who may reverse and never when.
 * `expires_at` was declared and never read. And attestation marked
 * determinations due while erasure — which removes the ground entirely — did
 * not, which is how the taint test caught this on the way in.
 *
 * A rule that lives in one function is enforced. A rule that lives in a comment
 * is remembered until it isn't. Anything that changes what a subject's facts
 * are calls this.
 */
export async function markDue(
  tx: pg.PoolClient, workspaceId: string, subjectId: string,
): Promise<void> {
  await tx.query(
    `UPDATE seals SET evaluation_due = true
      WHERE workspace_id = $1 AND subject_id = $2 AND state IN ('sealed', 'tainted')`,
    [workspaceId, subjectId]);
}

export interface Reevaluation { sealId: string; from: string; to: string }

export interface SweepResult {
  /** Determinations whose state changed. */
  changes: Reevaluation[];
  /** How many were examined this pass. */
  examined: number;
  /**
   * How many remain due after this pass — dirty, never examined, or expired.
   * The worker loops again immediately while this is non-zero rather than
   * sleeping through a backlog.
   */
  remaining: number;
}

/**
 * Re-run sealed rules against current attestations.
 *
 * This is the unbiased correction channel. A lapse is the institution
 * discovering it was wrong about somebody who never said a word — the only
 * error signal that does not require the affected person to have the resources
 * to fight. Roughly nine in ten Medicaid denials are never appealed, so it is
 * also the only signal that sees them at all.
 *
 * ORDERING IS THE WHOLE CORRECTNESS ARGUMENT, and it used to be wrong. This
 * selected `ORDER BY sealed_at LIMIT 100`, and a determination that does not
 * change state stays at the front of that ordering permanently — so the sweep
 * re-examined the same oldest hundred forever and never reached the
 * hundred-and-first. Measured: 105 determinations, facts changed under the
 * newest, five complete sweeps, still `sealed`.
 *
 * Now: due work first (an attestation landed for that subject, or it has run
 * out), then least recently examined. `last_evaluated_at` advances for every
 * row EXAMINED rather than every row changed, which is what makes the cursor
 * move and every determination eventually reachable.
 */
export async function reevaluate(workspaceId: string, limit = 100): Promise<SweepResult> {
  const pool = (await import('../db/pool.js')).getPool();
  const { rows } = await pool.query<{
    id: string; subject_id: string; rule: Rule; state: string;
    grammar_version: string; expired: boolean;
  }>(
    `SELECT id, subject_id, rule, state, grammar_version,
            (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM seals
      WHERE workspace_id = $1 AND state IN ('sealed', 'tainted')
        AND (evaluation_due
             OR last_evaluated_at IS NULL
             OR (expires_at IS NOT NULL AND expires_at <= now()))
      ORDER BY evaluation_due DESC, last_evaluated_at NULLS FIRST
      LIMIT $2`,
    [workspaceId, limit]);

  const changes: Reevaluation[] = [];
  for (const s of rows) {
    let next: string;
    if (s.expired) {
      // Ran out. NOT an error — collapsing this into `lapsed` would count
      // every expiry as the institution having been wrong.
      next = 'expired';
    } else if (!SUPPORTED_GRAMMAR_VERSIONS.has(s.grammar_version)) {
      // Cannot reproduce the semantics this was sealed under, so cannot check
      // it. Lost ground, not a disproof — and never a silent re-decision under
      // rules nobody agreed to.
      next = 'tainted';
    } else {
      const names = [...factsReferenced(s.rule)];
      const { facts } = await loadFacts(pool, workspaceId, s.subject_id, names);
      try {
        next = classify(evaluate(s.rule, facts));
      } catch {
        // A type mismatch against changed attestations means the ground moved
        // in a way the rule cannot read. Lost ground, not a disproof.
        next = 'tainted';
      }
    }

    await withTx(async (tx) => {
      // The cursor advances whether or not anything changed. A pass that
      // examines a determination and leaves it alone has still examined it,
      // and recording that is what stops the sweep looping on its own head.
      const { rowCount } = await tx.query(
        `UPDATE seals
            SET state = $2,
                settled_at = CASE WHEN $2 IN ('lapsed','expired') THEN now() ELSE settled_at END,
                last_evaluated_at = now(),
                evaluation_due = false
          WHERE id = $1 AND state = $3`,
        [s.id, next, s.state]);
      if (rowCount === 0) return;  // somebody clawed it first; their record wins
      if (next === s.state) return;
      await tx.query(
        `INSERT INTO seal_events (seal_id, workspace_id, kind, detail)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [s.id, workspaceId, next, JSON.stringify({ from: s.state })]);
      changes.push({ sealId: s.id, from: s.state, to: next });
    });
  }

  const { rows: left } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM seals
      WHERE workspace_id = $1 AND state IN ('sealed', 'tainted')
        AND (evaluation_due
             OR last_evaluated_at IS NULL
             OR (expires_at IS NOT NULL AND expires_at <= now()))`,
    [workspaceId]);

  return { changes, examined: rows.length, remaining: Number(left[0]!.n) };
}

/**
 * The worst-case age of the evidence, per workspace.
 *
 * `Metrics must be measurable and provide evidence that a state meets its
 * outcomes on an ongoing basis` — 42 CFR 433.112(b)(15). "Ongoing" is not a
 * property a system can assert; it is a number, and this is the number. If the
 * oldest unexamined determination was last checked eleven days ago, then the
 * correction channel is eleven days stale and no amount of documentation makes
 * it otherwise.
 */
export async function sweepLag(db: Db, workspaceId: string): Promise<{
  open: number; neverEvaluated: number; dueNow: number; oldestEvaluatedAt: Date | null;
}> {
  const { rows } = await db.query<{
    open: string; never_evaluated: string; due_now: string; oldest: Date | null;
  }>(
    `SELECT count(*)                                              AS open,
            count(*) FILTER (WHERE last_evaluated_at IS NULL)     AS never_evaluated,
            count(*) FILTER (WHERE evaluation_due
                                OR last_evaluated_at IS NULL
                                OR (expires_at IS NOT NULL AND expires_at <= now()))
                                                                  AS due_now,
            min(last_evaluated_at)                                AS oldest
       FROM seals
      WHERE workspace_id = $1 AND state IN ('sealed', 'tainted')`,
    [workspaceId]);
  const r = rows[0]!;
  return {
    open: Number(r.open),
    neverEvaluated: Number(r.never_evaluated),
    dueNow: Number(r.due_now),
    oldestEvaluatedAt: r.oldest,
  };
}

export { TRUE, FALSE, UNKNOWN };
