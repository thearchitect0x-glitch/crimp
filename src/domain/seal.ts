// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
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
  aliases: unknown;
  scope: string;
  disposition: Disposition;
  rule: unknown;
  claw: ClawRule;
  maxUses?: number | null;
  /** Fact classes policy requires this effect type's rules to reference. */
  requiredFacts?: readonly string[];
}

export interface SealResult {
  sealId: string | null;
  /** `sealed` when the rule held; `not_applicable` when it did not. */
  outcome: 'sealed' | 'not_applicable';
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
    `SELECT fact, fact_type, bool_value, int_value, str_value, source, admissibility, asserted_at
       FROM attestations
      WHERE workspace_id = $1 AND subject_id = $2 AND fact = ANY($3::text[])`,
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
                          sealed_by, claw_authority, claw_evidence_floor, claw_cooling_off_s, max_uses)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
      [sealId, workspaceId, subjectId, scope, input.disposition, JSON.stringify(rule),
        ruleHash, sealedBy, clawRule.authority, clawRule.evidenceFloor,
        clawRule.coolingOffSeconds, input.maxUses ?? null],
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

/* ── Check: the hot path ─────────────────────────────────────────────── */

export interface CheckResult {
  bound: boolean;
  reason: string;
  sealId?: string;
  disposition?: Disposition;
  /** Only issued when nothing binds. The effect gate requires it. */
  bindingToken?: string;
}

const CHECK_REASONS = {
  clear: 'no_determination',
  bind: 'bound.refusal_standing',
  tainted: 'bound.tainted',
  spent: 'permit.already_exercised',
  granted: 'permit.exercised',
} as const;

/**
 * Is this action bound?
 *
 * Sits in front of every agent action, so it is one indexed scan over the
 * bounded ancestor set of the requested scope. A slow answer is a bypassed
 * answer.
 *
 * A refusal increments pressure. That is the observable nothing else can have:
 * nobody anywhere records how many times somebody tried to get past a decision
 * and was stopped.
 */
export async function check(p: Principal, args: {
  aliases: unknown;
  scope: string;
  session?: string;
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<CheckResult> {
  requireScope(p, 'bindings:check');
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
    if (sub.length === 0) {
      return { bound: false, reason: CHECK_REASONS.clear, bindingToken: mintToken(scope) };
    }
    if (sub.length > 1) {
      throw new ApiError(409, 'merge_required',
        'These aliases identify several subjects; resolve the merge before checking.',
        { subjects: sub.length });
    }
    const subjectId = sub[0]!.subject_id;

    const { rows: found } = await tx.query<{
      id: string; scope: string; disposition: Disposition; state: string;
      max_uses: number | null; uses: number;
    }>(
      `SELECT id, scope, disposition, state, max_uses, uses
         FROM seals
        WHERE workspace_id = $1 AND subject_id = $2 AND scope = ANY($3::text[])
          AND state IN ('sealed', 'tainted')
        ORDER BY sealed_at`,
      [workspaceId, subjectId, ancestors(scope)],
    );

    // A bind anywhere in the covering set refuses, even a tainted one. Tainted
    // means the ground is gone, not that the claim was disproved, and lifting
    // on an unknown is exactly the guess a gate must never make.
    const binding = found.find((s) => s.disposition === 'bind' && covers(s.scope, scope));
    if (binding) {
      await bumpPressure(tx, binding.id, args.session);
      return {
        bound: true,
        reason: binding.state === 'tainted' ? CHECK_REASONS.tainted : CHECK_REASONS.bind,
        sealId: binding.id,
        disposition: 'bind',
      };
    }

    const permit = found.find((s) => s.disposition === 'permit' && covers(s.scope, scope));
    if (permit) {
      // At-most-N enforced by the database, not by application logic — the
      // same reasoning as Ratchet's unique index. Two concurrent callers
      // cannot both win the last use.
      const { rowCount } = await tx.query(
        `UPDATE seals SET uses = uses + 1
          WHERE id = $1 AND (max_uses IS NULL OR uses < max_uses)`, [permit.id]);
      if (rowCount === 0) {
        await bumpPressure(tx, permit.id, args.session);
        return { bound: true, reason: CHECK_REASONS.spent, sealId: permit.id, disposition: 'permit' };
      }
      await tx.query(
        `INSERT INTO seal_events (seal_id, workspace_id, kind) VALUES ($1,$2,'exercised')`,
        [permit.id, workspaceId]);
      return {
        bound: false, reason: CHECK_REASONS.granted, sealId: permit.id,
        disposition: 'permit', bindingToken: mintToken(scope),
      };
    }

    return { bound: false, reason: CHECK_REASONS.clear, bindingToken: mintToken(scope) };
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

/** Placeholder until the effect-gate join lands; shape is stable, signing is not. */
function mintToken(scope: string): string {
  return `bt_${sha256Hex(`${newId('n')}:${scope}`).slice(0, 32)}`;
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

export interface Reevaluation { sealId: string; from: string; to: string }

/**
 * Re-run sealed rules against current attestations.
 *
 * This is the unbiased correction channel. A lapse is the institution
 * discovering it was wrong about somebody who never said a word — the only
 * error signal that does not require the affected person to have the resources
 * to fight.
 */
export async function reevaluate(workspaceId: string, limit = 100): Promise<Reevaluation[]> {
  const pool = (await import('../db/pool.js')).getPool();
  const { rows } = await pool.query<{
    id: string; subject_id: string; rule: Rule; state: string;
  }>(
    `SELECT id, subject_id, rule, state FROM seals
      WHERE workspace_id = $1 AND state IN ('sealed', 'tainted')
      ORDER BY sealed_at LIMIT $2`,
    [workspaceId, limit]);

  const changes: Reevaluation[] = [];
  for (const s of rows) {
    const names = [...factsReferenced(s.rule)];
    const { facts } = await loadFacts(pool, workspaceId, s.subject_id, names);
    let next: string;
    try {
      next = classify(evaluate(s.rule, facts));
    } catch {
      // A type mismatch against changed attestations means the ground moved in
      // a way the rule cannot read. That is lost ground, not a disproof.
      next = 'tainted';
    }
    if (next === s.state) continue;

    await withTx(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE seals SET state = $2, settled_at = CASE WHEN $2 = 'lapsed' THEN now() ELSE settled_at END
          WHERE id = $1 AND state = $3`,
        [s.id, next, s.state]);
      if (rowCount === 0) return;  // somebody clawed it first; their record wins
      await tx.query(
        `INSERT INTO seal_events (seal_id, workspace_id, kind, detail)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [s.id, workspaceId, next, JSON.stringify({ from: s.state })]);
      changes.push({ sealId: s.id, from: s.state, to: next });
    });
  }
  return changes;
}

export { TRUE, FALSE, UNKNOWN };
