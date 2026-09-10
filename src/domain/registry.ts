// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-08 · The rule registry.
 *
 * A rule may still arrive inline with the seal that uses it — that is the
 * product's thesis and nothing here removes it. What the registry adds is a
 * committed, citable, versioned home for the rules a programme has actually
 * adopted, so that a determination can say which law it implemented and which
 * version of the policy was in force on the date it is about.
 *
 * THREE THINGS THIS DELIBERATELY IS NOT.
 *
 * It is not a pointer the seal dereferences. The seal keeps its rule inline,
 * and `rule_ref` is a snapshot beside it. A proof must verify in 2032 without
 * this table existing.
 *
 * It is not a version number. The version IS the canonical-form hash, so a
 * committed rule is immutable by construction — you cannot edit a hash, only
 * commit a successor with a new effective window — and two workspaces that
 * commit the same policy text share one version, which is what lets "how often
 * does this policy shape lapse" be asked across tenants without sharing a fact
 * about anybody.
 *
 * It is not a clock for the evaluator. `as_of` selects a version in the seal
 * path, before evaluation. The evaluator receives a concrete rule and remains
 * unable to see time except as an attested fact.
 */
import { withTx, getPool, type Db } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { sha256Hex } from '../lib/ids.js';
import { validateRule, canonicalRule, GRAMMAR_VERSION, type Rule } from './rule.js';
import { validateScope, covers } from './scope.js';
import { rankOf } from './authority.js';
import { requireScope, type Principal } from './auth.js';
import { loadCatalogue, assertCatalogued } from './catalogue.js';

const RULESET = /^[a-z][a-z0-9_]{0,30}$/;
const RULE_ID = /^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$/;

/**
 * Committing policy is an operator act. An agent may still submit a rule inline
 * — that is the point of the product — but it may not author the committed
 * policy it is then bound by, for the same reason it may not mint its own
 * authority.
 */
export const COMMIT_AUTHORITY = 'operator';

/**
 * A citation, validated for shape and stored as written.
 *
 * Accepts the two federal forms an examiner will actually look up — CFR and
 * USC — and a bounded free form for state law and programme manuals, because
 * the alternative is refusing citations this codebase has never seen. What is
 * NOT accepted is the empty string, which is how "we will add the citation
 * later" becomes a determination nobody can trace to a law.
 */
const CITATION = /^(\d{1,2} CFR \d{1,4}(\.\d{1,4})?(\([a-z0-9]{1,4}\))*|\d{1,2} U\.?S\.?C\.? §? ?\d{1,5}[a-z]?(\([a-z0-9]{1,4}\))*|[A-Za-z][A-Za-z0-9 .,§()/&'\-]{2,199})$/;

export function validateCitation(s: unknown): string {
  if (typeof s !== 'string' || !CITATION.test(s.trim())) {
    throw new ApiError(400, 'invalid_citation',
      'legal_authority must be a CFR or USC citation, or a state-law reference of 3 to 200 '
      + 'characters. A rule with no traceable authority is a determination nobody can appeal.',
      { received: s });
  }
  return s.trim();
}

export interface RuleRef {
  ruleset: string;
  ruleId: string;
  /** The canonical-form hash of the rule text. */
  version: string;
  legalAuthority: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * The record-format shape of a reference (SPEC §7.0a). This is ALSO what the
 * `seals.rule_ref` column holds, so the proof export is a pass-through and the
 * database row is the record, not something a serializer reconstructs.
 */
export interface StoredRuleRef {
  ruleset: string;
  rule_id: string;
  version: string;
  legal_authority: string;
  effective_from: string;
  effective_to: string | null;
}

export const toStored = (r: RuleRef): StoredRuleRef => ({
  ruleset: r.ruleset, rule_id: r.ruleId, version: r.version, legal_authority: r.legalAuthority,
  effective_from: r.effectiveFrom.toISOString(),
  effective_to: r.effectiveTo === null ? null : r.effectiveTo.toISOString(),
});

export const fromStored = (s: StoredRuleRef): RuleRef => ({
  ruleset: s.ruleset, ruleId: s.rule_id, version: s.version, legalAuthority: s.legal_authority,
  effectiveFrom: new Date(s.effective_from),
  effectiveTo: s.effective_to === null ? null : new Date(s.effective_to),
});

export interface RegisteredRule extends RuleRef {
  rule: Rule;
  grammarVersion: string;
  scope: string | null;
  committedBy: string;
  committedAt: Date;
  note: string | null;
}

interface RuleRow {
  ruleset: string; rule_id: string; version: string; rule: Rule; grammar_version: string;
  legal_authority: string; scope: string | null; effective_from: Date; effective_to: Date | null;
  committed_by: string; committed_at: Date; note: string | null;
}

const fromRow = (r: RuleRow): RegisteredRule => ({
  ruleset: r.ruleset, ruleId: r.rule_id, version: r.version, rule: r.rule,
  grammarVersion: r.grammar_version, legalAuthority: r.legal_authority, scope: r.scope,
  effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  committedBy: r.committed_by, committedAt: r.committed_at, note: r.note,
});

export async function declareRuleset(p: Principal, args: {
  ruleset: string; description?: string | null;
  /**
   * cap-07. The rule that IS this programme's ex parte determination — the
   * one 42 CFR 435.916(b)(1) says must be tried from facts on file before a
   * person is asked for anything. While it is decidable, no procedural rule
   * under this ruleset may seal. Null means the programme has not said.
   */
  exParteRule?: string | null;
}): Promise<{ ruleset: string; exParteRule: string | null }> {
  requireScope(p, 'rules:write');
  requireCommitAuthority(p);
  if (typeof args.ruleset !== 'string' || !RULESET.test(args.ruleset)) {
    throw new ApiError(400, 'invalid_request',
      'A ruleset name is one lowercase segment: letters, digits, underscores, at most 31 characters.');
  }
  const exParteRule = args.exParteRule ?? null;
  if (exParteRule !== null && !RULE_ID.test(exParteRule)) {
    throw new ApiError(400, 'invalid_request', `ex_parte_rule ${JSON.stringify(exParteRule)} is not a usable rule id.`);
  }
  // Re-declaring updates what a programme says about itself; it never drops
  // rules. The ex parte rule may be named before it is committed — it must
  // be in force by the time a procedural rule is sealed, and that is checked there.
  const { rows } = await getPool().query<{ ex_parte_rule: string | null }>(
    `INSERT INTO rulesets (workspace_id, ruleset, description, ex_parte_rule) VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, ruleset) DO UPDATE SET
       description = coalesce(EXCLUDED.description, rulesets.description),
       ex_parte_rule = EXCLUDED.ex_parte_rule
     RETURNING ex_parte_rule`,
    [p.workspaceId, args.ruleset, args.description ?? null, exParteRule]);
  return { ruleset: args.ruleset, exParteRule: rows[0]?.ex_parte_rule ?? null };
}

/** The ex parte rule a ruleset names, if any. */
export async function exParteRuleOf(db: Db, workspaceId: string, ruleset: string): Promise<string | null> {
  const { rows } = await db.query<{ ex_parte_rule: string | null }>(
    'SELECT ex_parte_rule FROM rulesets WHERE workspace_id = $1 AND ruleset = $2', [workspaceId, ruleset]);
  return rows[0]?.ex_parte_rule ?? null;
}

/**
 * Commit a rule version.
 *
 * Idempotent on content: committing byte-identical policy text twice yields
 * one version, because the version is the hash. Committing DIFFERENT text
 * under the same id with an overlapping window is refused by the database's
 * exclusion constraint, and the refusal names the overlap — a policy cannot
 * have two answers on the same day.
 *
 * This is the commit step capability 1(d) and finding F1 hook into: every
 * check that should refuse a rule before it can ever be sealed runs here, once,
 * rather than on every seal.
 */
export async function commitRule(p: Principal, args: {
  ruleset: string;
  ruleId: string;
  rule: unknown;
  legalAuthority: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  scope?: string | null;
  note?: string | null;
}): Promise<RegisteredRule & { outcome: 'committed' | 'already_committed' }> {
  requireScope(p, 'rules:write');
  requireCommitAuthority(p);
  if (!RULESET.test(args.ruleset)) {
    throw new ApiError(400, 'invalid_request', `Ruleset ${JSON.stringify(args.ruleset)} is not usable.`);
  }
  if (typeof args.ruleId !== 'string' || !RULE_ID.test(args.ruleId)) {
    throw new ApiError(400, 'invalid_request',
      `Rule id ${JSON.stringify(args.ruleId)} is not usable. Ids are dotted lowercase segments, like a fact name.`);
  }
  const legalAuthority = validateCitation(args.legalAuthority);
  if (!(args.effectiveFrom instanceof Date) || Number.isNaN(args.effectiveFrom.getTime())) {
    throw new ApiError(400, 'invalid_request', 'effective_from must be a timestamp.');
  }
  const effectiveTo = args.effectiveTo ?? null;
  if (effectiveTo !== null && (!(effectiveTo instanceof Date) || Number.isNaN(effectiveTo.getTime()))) {
    throw new ApiError(400, 'invalid_request', 'effective_to must be a timestamp or null.');
  }
  if (effectiveTo !== null && effectiveTo <= args.effectiveFrom) {
    throw new ApiError(400, 'invalid_request', 'effective_to must be after effective_from.');
  }
  const scope = args.scope == null ? null : validateScope(args.scope);

  // The same validation a seal runs. A rule that cannot be sealed cannot be
  // committed either, and hearing that here is cheaper than hearing it later.
  const referenced = validateRule(args.rule);
  const rule = args.rule as Rule;
  const version = sha256Hex(canonicalRule(rule));

  return withTx(async (tx) => {
    const { rows: rs } = await tx.query(
      'SELECT 1 FROM rulesets WHERE workspace_id = $1 AND ruleset = $2', [p.workspaceId, args.ruleset]);
    if (rs.length === 0) {
      throw new ApiError(404, 'unknown_ruleset',
        `Ruleset "${args.ruleset}" is not declared in this workspace.`, { ruleset: args.ruleset });
    }
    // Test (d) of capability 1, made structural: a synonym for a guarded fact
    // is not detected, it is a fact the programme never defined, and a closed
    // catalogue refuses it by name.
    assertCatalogued(await loadCatalogue(tx, p.workspaceId), referenced, 'a committed rule');

    // Idempotent on content. The same text is the same version; a second
    // commit of it is a replay, not a conflict.
    const { rows: prior } = await tx.query<RuleRow>(
      `SELECT ruleset, rule_id, version, rule, grammar_version, legal_authority, scope,
              effective_from, effective_to, committed_by, committed_at, note
         FROM rules WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3 AND version = $4`,
      [p.workspaceId, args.ruleset, args.ruleId, version]);
    if (prior[0]) return { ...fromRow(prior[0]), outcome: 'already_committed' as const };

    try {
      const { rows } = await tx.query<RuleRow>(
        `INSERT INTO rules (workspace_id, ruleset, rule_id, version, rule, grammar_version,
                            legal_authority, scope, effective_from, effective_to,
                            committed_by, committed_key, note)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING ruleset, rule_id, version, rule, grammar_version, legal_authority, scope,
                   effective_from, effective_to, committed_by, committed_at, note`,
        [p.workspaceId, args.ruleset, args.ruleId, version, JSON.stringify(rule), GRAMMAR_VERSION,
          legalAuthority, scope, args.effectiveFrom, effectiveTo, p.authority, p.keyId,
          args.note ?? null]);
      return { ...fromRow(rows[0]!), outcome: 'committed' as const };
    } catch (err) {
      // The failed INSERT has aborted `tx`; anything asked from here on is
      // asked of the pool, and withTx rolls the transaction back on throw.
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        // Two commits of the same content raced. The second is a replay.
        const { rows: raced } = await getPool().query<RuleRow>(
          `SELECT ruleset, rule_id, version, rule, grammar_version, legal_authority, scope,
                  effective_from, effective_to, committed_by, committed_at, note
             FROM rules WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3 AND version = $4`,
          [p.workspaceId, args.ruleset, args.ruleId, version]);
        if (raced[0]) return { ...fromRow(raced[0]), outcome: 'already_committed' as const };
      }
      // 23P01 is exclusion_violation: another version of this rule id is
      // already in force somewhere inside the requested window.
      if (code === '23P01') {
        const { rows: clash } = await getPool().query<{ version: string; effective_from: Date; effective_to: Date | null }>(
          `SELECT version, effective_from, effective_to FROM rules
            WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3
              AND tstzrange(effective_from, effective_to, '[)') && tstzrange($4, $5, '[)')`,
          [p.workspaceId, args.ruleset, args.ruleId, args.effectiveFrom, effectiveTo]);
        throw new ApiError(409, 'rule_window_overlap',
          `Another version of "${args.ruleId}" is already in force inside that window. A policy `
          + 'cannot have two answers on the same day: close the earlier version with an '
          + 'effective_to first.',
          { ruleId: args.ruleId, inForce: clash.map((c) => ({
            version: c.version, effectiveFrom: c.effective_from, effectiveTo: c.effective_to })) });
      }
      throw err;
    }
  });
}

/**
 * Close a version's window — the one change a committed version admits.
 *
 * The law changed on a date; the version that implemented the old law stops
 * governing on that date. Content is untouched, so `version` is untouched, so
 * every seal's snapshot still names a real thing. The exclusion constraint
 * still stands guard: a close that would make this version overlap a
 * successor is refused by the database, not by a check somebody could forget.
 */
export async function closeRule(p: Principal, args: {
  ruleset: string; ruleId: string; version: string; effectiveTo: Date;
}): Promise<RegisteredRule> {
  requireScope(p, 'rules:write');
  requireCommitAuthority(p);
  if (!(args.effectiveTo instanceof Date) || Number.isNaN(args.effectiveTo.getTime())) {
    throw new ApiError(400, 'invalid_request', 'effective_to must be a timestamp.');
  }
  try {
    const { rows } = await getPool().query<RuleRow>(
      `UPDATE rules SET effective_to = $5, closed_by = $6, closed_at = now()
        WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3 AND version = $4
          AND effective_from < $5
        RETURNING ruleset, rule_id, version, rule, grammar_version, legal_authority, scope,
                  effective_from, effective_to, committed_by, committed_at, note`,
      [p.workspaceId, args.ruleset, args.ruleId, args.version, args.effectiveTo, p.authority]);
    if (rows[0]) return fromRow(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23P01') {
      throw new ApiError(409, 'rule_window_overlap',
        'Closing there would make this version overlap a successor. Move the successor first.',
        { ruleId: args.ruleId, version: args.version, effectiveTo: args.effectiveTo.toISOString() });
    }
    throw err;
  }
  // Nothing updated: the version does not exist here, or the close date is
  // not after its start. Distinguish them, because they are different mistakes.
  const { rows } = await getPool().query<{ effective_from: Date }>(
    `SELECT effective_from FROM rules
      WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3 AND version = $4`,
    [p.workspaceId, args.ruleset, args.ruleId, args.version]);
  if (rows[0]) {
    throw new ApiError(400, 'invalid_request',
      `effective_to must be after this version's effective_from (${rows[0].effective_from.toISOString()}).`);
  }
  throw new ApiError(404, 'unknown_rule',
    `No version ${args.version.slice(0, 12)}… of "${args.ruleId}" in ruleset "${args.ruleset}".`,
    { ruleset: args.ruleset, ruleId: args.ruleId, version: args.version });
}

/**
 * The version of a rule in force on a given date.
 *
 * Exactly one row can match, by the exclusion constraint. None means the
 * rule either did not exist yet or had been withdrawn — both are refusals,
 * with different messages, because "we have no policy for that date" is not
 * the same finding as "you spelled the rule id wrong".
 */
export async function resolveRule(
  db: Db, workspaceId: string, ruleset: string, ruleId: string, asOf: Date,
): Promise<RegisteredRule> {
  const { rows } = await db.query<RuleRow>(
    `SELECT ruleset, rule_id, version, rule, grammar_version, legal_authority, scope,
            effective_from, effective_to, committed_by, committed_at, note
       FROM rules
      WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3
        AND tstzrange(effective_from, effective_to, '[)') @> $4::timestamptz`,
    [workspaceId, ruleset, ruleId, asOf]);
  if (rows[0]) return fromRow(rows[0]);

  const { rows: any } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM rules WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3',
    [workspaceId, ruleset, ruleId]);
  if (Number(any[0]?.n ?? 0) === 0) {
    throw new ApiError(404, 'unknown_rule',
      `No rule "${ruleId}" in ruleset "${ruleset}".`, { ruleset, ruleId });
  }
  throw new ApiError(409, 'no_rule_in_force',
    `Rule "${ruleId}" exists but no version of it was in force on ${asOf.toISOString()}. `
    + 'A determination cannot be made under a policy that did not apply on the date it is about.',
    { ruleset, ruleId, asOf: asOf.toISOString() });
}

/** Every version of one rule, oldest first. What an examiner asks for. */
export async function ruleHistory(
  p: Principal, ruleset: string, ruleId: string,
): Promise<RegisteredRule[]> {
  requireScope(p, 'rules:read');
  const { rows } = await getPool().query<RuleRow>(
    `SELECT ruleset, rule_id, version, rule, grammar_version, legal_authority, scope,
            effective_from, effective_to, committed_by, committed_at, note
       FROM rules WHERE workspace_id = $1 AND ruleset = $2 AND rule_id = $3
      ORDER BY effective_from`,
    [p.workspaceId, ruleset, ruleId]);
  return rows.map(fromRow);
}

/** The snapshot a seal carries. Everything an examiner needs to cite, nothing to dereference. */
export function refOf(r: RegisteredRule): RuleRef {
  return {
    ruleset: r.ruleset, ruleId: r.ruleId, version: r.version,
    legalAuthority: r.legalAuthority, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
  };
}

/** Does a seal's scope sit inside the registered rule's declared scope, if it has one? */
export function assertScopeWithin(rule: RegisteredRule, sealScope: string): void {
  if (rule.scope !== null && !covers(rule.scope, sealScope)) {
    throw new ApiError(400, 'rule_scope_mismatch',
      `Rule "${rule.ruleId}" is declared for scope "${rule.scope}"; a determination in `
      + `"${sealScope}" is outside it.`, { ruleScope: rule.scope, sealScope });
  }
}

function requireCommitAuthority(p: Principal): void {
  if (rankOf(p.authority) < rankOf(COMMIT_AUTHORITY)) {
    throw new ApiError(403, 'insufficient_authority',
      `Committing policy requires ${COMMIT_AUTHORITY} authority; this key is ${p.authority}. `
      + 'An agent may apply a rule; it may not author the policy it is then bound by.',
      { required: COMMIT_AUTHORITY, held: p.authority });
  }
}

