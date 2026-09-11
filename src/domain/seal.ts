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
import { withTx, getPool, type Db } from '../db/pool.js';
import { newId, sha256Hex, canonicalize } from '../lib/ids.js';
import { ApiError } from '../lib/errors.js';
import { blindAliases, type MergeStrength } from '../lib/blind.js';
import { resolveForRead, resolveForWrite } from './subject.js';
import { reasons, type Reason } from './explain.js';
import {
  validateRule, canonicalRule, factsReferenced,
  GRAMMAR_VERSION, SUPPORTED_GRAMMAR_VERSIONS,
  TRUE, FALSE, UNKNOWN,
  type Rule, type Facts, type Fact, type FactType, type Truth,
} from './rule.js';
import { evaluate } from './evaluate.js';
import { validateScope, ancestors, covers } from './scope.js';
import {
  validateClawRule, mayClaw, isAuthority, TIME_BOUNDS, QUORUM_WINDOW_SECONDS,
  type Authority, type ClawRule,
} from './authority.js';
import { meetsFloor, type Admissibility } from './admissibility.js';
import { requireScope, type Principal } from './auth.js';
import {
  resolveRule, refOf, fromStored, toStored as toStoredRef, assertScopeWithin, exParteRuleOf,
  type RuleRef, type StoredRuleRef,
} from './registry.js';
import { loadCatalogue, assertCatalogued, applyGuards, guardsOf } from './catalogue.js';
import { corrections, favourable, type Remedy } from './remedy.js';
import { harmOf, harmToStored } from './harm.js';
import { logEvaluation } from './drift.js';
import { signer } from './signer.js';
import { loadProof, recordCore } from './record.js';
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
  /** The rule, inline. Optional only when `ruleRef` names a registered one. */
  rule?: unknown;
  /**
   * A registered rule to seal under (cap-08). Resolved to the version in force
   * on `asOf` BEFORE evaluation; the evaluator receives a concrete rule and
   * remains unable to see a clock. If `rule` is also given it must be the same
   * rule, or the caller has told two stories and is refused.
   */
  ruleRef?: { ruleset: string; ruleId: string } | null;
  /**
   * The date the decision is ABOUT, which is not always the date it is made.
   * Selects the registry version; recorded on the seal; never read by
   * evaluation. Null means "as of now".
   */
  asOf?: Date | null;
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
  /** Which registered version was selected, so nothing is decided silently. Null for an inline rule. */
  ruleRef: RuleRef | null;
  /**
   * What would move this the person's way (cap-02). For a sealed refusal,
   * what would make it lapse; for a permit that did not apply, what would
   * earn it. Null for a commit, and for a refusal that did not apply — there
   * is nothing to remedy in not being refused.
   */
  remedy: Remedy | null;
  reason: string;
  /**
   * The clauses that decided it, value-free.
   *
   * Returned to whoever created the determination without any further gate:
   * every field is a projection of the rule they just submitted, so it
   * discloses nothing they did not already send. The observed values are a
   * separate, recorded act — see `disclosure()`.
   */
  reasons: Reason[];
  /**
   * When this determination stops standing.
   *
   * Returned because Crimp may have chosen it. An absent expiry from anything
   * below `custodian` is capped at that authority's ceiling rather than
   * refused — the door closes itself instead of demanding the caller remember
   * to close it — and the caller is told what it got rather than left to
   * assume forever.
   */
  expiresAt: Date | null;
}

/* ── Subject resolution ──────────────────────────────────────────────── */

/* ── Attested facts ──────────────────────────────────────────────────── */

interface FactRow {
  fact: string; fact_type: FactType;
  bool_value: boolean | null; int_value: number | null; str_value: string | null;
  source: string; admissibility: Admissibility; asserted_at: Date; attester: string | null;
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
    `SELECT fact, fact_type, bool_value, int_value, str_value, source, admissibility, asserted_at,
            attester
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

/* ── Ex parte (cap-07) ───────────────────────────────────────────────── */

/**
 * Try the programme's substantive rule from facts on file before a
 * procedural rule may seal. Returns what was tried and how it came out, for
 * the record, or null when the rule is not procedural. Throws when the merits
 * are decidable — the refusal names the facts and the programmes they came
 * from, which is the remedy: "you already have this".
 */
async function exParteAttempt(
  tx: pg.PoolClient, workspaceId: string, subjectId: string,
  catalogue: Awaited<ReturnType<typeof loadCatalogue>>, referenced: ReadonlySet<string>,
  ruleRef: RuleRef | null, asOf: Date | null,
): Promise<Record<string, unknown> | null> {
  const procedural = [...referenced].some((f) => catalogue.get(f)?.class === 'non_response');
  if (!procedural) return null;
  if (ruleRef === null) {
    throw new ApiError(400, 'procedural_needs_registry',
      'A rule that rests on a non-response fact is a procedural determination, and a procedural '
      + 'determination must be made under a committed rule so the programme\'s ex parte rule can '
      + 'be tried first. Seal it with a rule_ref.', { nonResponse: [...referenced].filter((f) => catalogue.get(f)?.class === 'non_response') });
  }
  const exParteId = await exParteRuleOf(tx, workspaceId, ruleRef.ruleset);
  if (exParteId === null) return { ruleset: ruleRef.ruleset, rule_id: null, outcome: 'not_declared' };

  let substantive;
  try {
    substantive = await resolveRule(tx, workspaceId, ruleRef.ruleset, exParteId, asOf ?? new Date());
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'unknown_rule' || e.code === 'no_rule_in_force')) {
      throw new ApiError(409, 'ex_parte_rule_not_in_force',
        `Ruleset "${ruleRef.ruleset}" names "${exParteId}" as its ex parte rule, but no version of it is in `
        + 'force for this date. A programme that has declared how it decides on the merits must keep '
        + 'that rule in force before it may terminate anybody procedurally.',
        { ruleset: ruleRef.ruleset, exParteRule: exParteId, cause: e.code });
    }
    throw e;
  }
  const names = [...factsReferenced(substantive.rule)];
  const loaded = await loadFacts(tx, workspaceId, subjectId, [...names, ...guardsOf(catalogue, names)]);
  const { facts } = applyGuards(catalogue, loaded.facts, names);
  let truth: Truth;
  try { truth = evaluate(substantive.rule, facts); } catch { truth = UNKNOWN; }

  const attempt = { ruleset: ruleRef.ruleset, rule_id: exParteId, version: substantive.version, outcome: truth };
  if (truth === UNKNOWN) {
    return { ...attempt, missing: names.filter((n) => facts[n] === undefined) };
  }
  const sources = [...new Set(loaded.rows.map((r) => r.source))];
  const { rows: prog } = await tx.query<{ source: string; programme: string | null }>(
    'SELECT source, programme FROM fact_sources WHERE workspace_id = $1 AND source = ANY($2::text[])',
    [workspaceId, sources]);
  const programmeOf = new Map(prog.map((r) => [r.source, r.programme]));
  throw new ApiError(409, 'cross_program_fact_available',
    `The merits can be decided from facts already on file: "${exParteId}" evaluates ${truth}. `
    + 'A procedural termination is not available while the determination can be made ex parte — '
    + 'decide it on the merits instead (42 CFR 435.916(b)(1)).',
    { ...attempt, facts: loaded.rows.filter((r) => facts[r.fact] !== undefined).map((r) => ({
      fact: r.fact, source: r.source, programme: programmeOf.get(r.source) ?? null,
      asserted_at: r.asserted_at.toISOString() })) });
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

  // THE CLOSER. A door nobody has to remember to shut.
  //
  // Absent expiry means forever, so an agent holding `seals:write` could author
  // a permanent refusal. Requiring an expiry would have been the obvious fix
  // and the worse one: a bound the caller can forget is not a bound, and this
  // bound exists to protect a third party — the person refused — who is not in
  // the conversation. So it is capped rather than demanded, and the chosen
  // value is returned so nothing is decided silently.
  //
  // `commit` is exempt: it records what an agent told a customer, and expiring
  // a commitment would erase it rather than end it.
  const maxDuration = TIME_BOUNDS[sealedBy].maxDurationSeconds;
  let expiresAt = input.expiresAt ?? null;
  if (maxDuration !== null && input.disposition !== 'commit') {
    const ceiling = new Date(Date.now() + maxDuration * 1000);
    if (expiresAt === null || expiresAt > ceiling) expiresAt = ceiling;
  }
  const clawRule = validateClawRule(sealedBy, input.claw, p.jurisdiction);

  const asOf = input.asOf ?? null;
  if (asOf !== null && (!(asOf instanceof Date) || Number.isNaN(asOf.getTime()))) {
    throw new ApiError(400, 'invalid_request', 'as_of must be a timestamp.');
  }

  // Registry selection happens HERE, before evaluation, and hands the
  // evaluator a concrete rule. Time enters the decision only as the date the
  // caller says the decision is about, and that date is recorded.
  let ruleRef: RuleRef | null = null;
  let ruleText: unknown = input.rule;
  if (input.ruleRef != null) {
    const registered = await resolveRule(getPool(), workspaceId,
      input.ruleRef.ruleset, input.ruleRef.ruleId, asOf ?? new Date());
    assertScopeWithin(registered, scope);
    // cap-10. A rule that says what kind of determination it makes binds
    // every seal under it. Otherwise "disposition" is an outcome field.
    if (registered.disposition !== null && registered.disposition !== input.disposition) {
      throw new ApiError(400, 'disposition_fixed_by_rule',
        `Rule "${registered.ruleId}" makes a ${registered.disposition}; it cannot be sealed as a `
        + `${input.disposition}. The kind of determination is committed with the rule, not chosen per seal.`,
        { ruleId: registered.ruleId, fixed: registered.disposition, requested: input.disposition });
    }
    if (ruleText !== undefined) {
      validateRule(ruleText);
      const inlineHash = sha256Hex(canonicalRule(ruleText as Rule));
      if (inlineHash !== registered.version) {
        throw new ApiError(400, 'rule_ref_mismatch',
          `The inline rule is not the version of "${registered.ruleId}" in force on `
          + `${(asOf ?? new Date()).toISOString()}. Send one or the other; sending both that `
          + 'disagree is two stories.',
          { inline: inlineHash, registered: registered.version });
      }
    }
    ruleText = registered.rule;
    ruleRef = refOf(registered);
  }
  if (ruleText === undefined) {
    throw new ApiError(400, 'invalid_request',
      'A determination needs a rule: inline, or a rule_ref into the registry.');
  }
  const referenced = validateRule(ruleText);
  const rule = ruleText as Rule;

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

  // cap-09. Every evaluation leaves a subject-free row — outcome and reason,
  // per rule — because two of the three outcomes otherwise leave nothing a
  // monitor could count. Written after the transaction settles, so a refusal
  // that rolled everything back is still counted as the `unknown` it was.
  const ruleKey = ruleRef === null ? ruleHash.slice(0, 16) : `${ruleRef.ruleset}/${ruleRef.ruleId}`;
  let result: SealResult;
  try {
    result = await sealInTx();
  } catch (e) {
    if (e instanceof ApiError && UNDECIDED.has(e.code)) {
      const guarded = (e.detail as { guarded?: unknown[] } | undefined)?.guarded;
      await logEvaluation(workspaceId, ruleKey, 'unknown',
        e.code === 'facts_not_attested' && Array.isArray(guarded) && guarded.length > 0
          ? 'delivery_unattested' : e.code);
    }
    throw e;
  }
  if (result.outcome !== 'replayed') {
    await logEvaluation(workspaceId, ruleKey, result.outcome === 'sealed' ? 'yes' : 'no', null);
  }
  return result;

  async function sealInTx(): Promise<SealResult> {
  return withTx(async (tx) => {
    // Replay before doing any work. A retry must be cheap and must not
    // re-resolve subjects or re-evaluate anything.
    const { rows: prior } = await tx.query<{
      id: string; disposition: Disposition; rule_hash: string;
      reasons: Reason[]; expires_at: Date | null; rule_ref: StoredRuleRef | null;
      remedy: Remedy | null;
    }>(`SELECT id, disposition, rule_hash, reasons, expires_at, rule_ref, remedy FROM seals
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
        // The reasons the ORIGINAL was decided on, not a fresh derivation
        // against today's facts. A replay must return the determination that
        // was made, or a retry after an attestation changed would report a
        // different decision under the same identifier. Same for the expiry.
        reasons: prior[0].reasons,
        expiresAt: prior[0].expires_at,
        ruleRef: prior[0].rule_ref === null ? null : fromStored(prior[0].rule_ref),
        remedy: prior[0].remedy,
      };
    }

    const { subjectId } = await resolveForWrite(tx, workspaceId, aliases,
      { doing: 'sealing a determination' });

    // A closed catalogue admits only what it names — for an inline rule here,
    // for a registered one at commit. Then the guards: a non-response fact is
    // withheld until its delivery fact holds, and the evaluator never learns
    // there was anything to withhold.
    const catalogue = await loadCatalogue(tx, workspaceId);
    assertCatalogued(catalogue, referenced, 'a rule');
    const loaded = await loadFacts(tx, workspaceId, subjectId,
      [...referenced, ...guardsOf(catalogue, referenced)]);
    const { facts, withheld } = applyGuards(catalogue, loaded.facts, referenced);
    // What the record commits to: every fact the evaluator read, and every
    // guard that held — the determination rested on the delivery as surely
    // as on the non-response it unlocked. A withheld fact is not here.
    const rows = loaded.rows.filter((r) => facts[r.fact] !== undefined);

    // cap-07. EX PARTE FIRST. A rule that rests on a non-response fact is a
    // procedural determination. Before one may seal, the programme's own
    // substantive rule is tried against every fact on file — from any
    // programme, because the fact store has no programmes. If the merits are
    // decidable, the procedural path is closed: decide it on the merits. If
    // they are not, the attempt is recorded on the seal: that record IS the
    // 42 CFR 435.916(b)(1) compliance evidence.
    const exParte = await exParteAttempt(tx, workspaceId, subjectId, catalogue, referenced, ruleRef, asOf);

    // Throws RuleTypeError (400) on a literal that cannot be compared with the
    // fact it names. That is a bug in the rule, not missing data, and it must
    // be refused loudly rather than absorbed as UNKNOWN.
    const truth = evaluate(rule, facts);

    // The direction that helps the person, if this disposition has one. A
    // remedy is derived from the rule's literals and the facts' CELLS, never
    // their values, so it sits at the same sensitivity as the reasons.
    const want = favourable(input.disposition);
    const remedyToward = (t: typeof TRUE | typeof FALSE | null): Remedy | null =>
      (t === null || t === truth ? null : corrections(rule, facts, t));

    if (truth === UNKNOWN) {
      const missing = [...referenced].filter((f) => facts[f] === undefined);
      throw new ApiError(409, 'facts_not_attested',
        'This rule reads facts that have not been attested, so it has not been answered — it has '
        + 'neither been satisfied nor violated. Attest them and seal again. An agent may not '
        + 'decide on facts it never gathered.'
        + (withheld.length > 0
          ? ` ${withheld.length} of them cannot be read until delivery is attested: `
            + withheld.map((w) => `${w.fact} (needs ${w.guardedBy} = ${w.requires}, `
              + `${w.observed === null ? 'nothing attested' : `attested ${w.observed}`})`).join('; ')
          : ''),
        { missing, guarded: withheld, remedy: remedyToward(want) });
    }

    if (truth === FALSE) {
      // Not an error. The agent applied its rule and the rule did not hold, so
      // no determination exists. Recorded nowhere as a seal, returned plainly.
      return {
        sealId: null, outcome: 'not_applicable' as const, expiresAt: null,
        disposition: input.disposition, ruleHash, ruleRef,
        // A permit that did not apply: what would earn it. A refusal that did
        // not apply needs no remedy — that IS the favourable outcome.
        remedy: remedyToward(want),
        reason: 'The rule did not hold against the attested facts. No determination was created.',
        // Which clauses failed, so the caller knows why their own rule did not
        // apply. Nothing is stored: no determination exists to attach it to.
        reasons: reasons(rule, facts, FALSE),
      };
    }

    // Derived here and stored, because it cannot be re-derived later: knowing
    // which branch of an `any` fired needs the facts as they were, and those
    // are kept only as digests.
    const why = reasons(rule, facts, TRUE);
    const remedy = remedyToward(want);

    const sealId = newId('seal');
    await tx.query(
      `INSERT INTO seals (id, workspace_id, subject_id, scope, disposition, rule, rule_hash,
                          grammar_version, sealed_by, claw_authority, claw_evidence_floor,
                          claw_cooling_off_s, max_uses, idempotency_key, expires_at,
                          reasons, claw_quorum, claw_jurisdiction,
                          last_evaluated_at, evaluation_due, rule_ref, as_of, remedy)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
               $17,$18,now(),false,$19::jsonb,$20,$21::jsonb)`,
      [sealId, workspaceId, subjectId, scope, input.disposition, JSON.stringify(rule),
        ruleHash, GRAMMAR_VERSION, sealedBy, clawRule.authority, clawRule.evidenceFloor,
        clawRule.coolingOffSeconds, input.maxUses ?? null,
        input.idempotencyKey, expiresAt, JSON.stringify(why),
        clawRule.quorum ?? 1, clawRule.jurisdiction ?? null,
        ruleRef === null ? null : JSON.stringify(toStoredRef(ruleRef)), asOf,
        remedy === null ? null : JSON.stringify(remedy)],
    );

    // One statement for every commitment: a round trip per fact was the
    // largest avoidable cost in the seal path once the pure work was measured
    // in microseconds.
    if (rows.length > 0) {
      const vals: unknown[] = [];
      const tuples = rows.map((r, i) => {
        const b = i * 8;
        vals.push(sealId, r.fact, r.fact_type, valueDigest(r), r.source, r.admissibility, r.asserted_at, r.attester);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      });
      await tx.query(
        `INSERT INTO seal_facts (seal_id, fact, fact_type, value_sha256, source, admissibility,
                                 asserted_at, attester)
         VALUES ${tuples.join(',')}`, vals);
    }

    // The issuer's signature over the sealed core, made now and never again:
    // the core does not move, so the signature stays valid for the life of
    // the record whatever happens to its state.
    const sg = signer();
    if (sg !== null) {
      const core = recordCore(await loadProof(tx, workspaceId, sealId));
      await tx.query('UPDATE seals SET signature = $2::jsonb WHERE id = $1',
        [sealId, JSON.stringify(sg.signCore(core))]);
    }

    await tx.query(
      `INSERT INTO seal_events (seal_id, workspace_id, kind, actor, detail)
       VALUES ($1,$2,'sealed',$3,$4::jsonb)`,
      [sealId, workspaceId, sealedBy,
        JSON.stringify({ scope, disposition: input.disposition, rule_hash: ruleHash,
          ...(ruleRef === null ? {} : { ruleset: ruleRef.ruleset, rule_id: ruleRef.ruleId }),
          ...(exParte === null ? {} : { ex_parte: exParte }) })],
    );

    return {
      sealId, outcome: 'sealed' as const, disposition: input.disposition, ruleHash, ruleRef,
      remedy, expiresAt,
      reason: 'The rule held. The determination is sealed.', reasons: why,
    };
  });
  }
}

/** Refusals that mean "not answered", as opposed to "malformed" or "not allowed". */
const UNDECIDED: ReadonlySet<string> = new Set([
  'facts_not_attested', 'cross_program_fact_available', 'ex_parte_rule_not_in_force', 'rule_type_mismatch',
]);

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
  /**
   * cap-06. A ruling elsewhere put the rule this rests on under review. The
   * determination still stands — nothing decided silently — and the reader
   * is told.
   */
  underReview: boolean;
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
    // Every alias counts on a read, weak ones included: a determination that
    // could be escaped by presenting a different device would not be one.
    // `resolveForRead` also raises `merge_required` and names the endpoint that
    // resolves it, which is what stopped this being a dead end.
    const subjectId = await resolveForRead(tx, workspaceId, aliases);
    if (subjectId === null) return { determinations: [] };

    const { rows: found } = await tx.query<{
      id: string; scope: string; disposition: Disposition; state: 'sealed' | 'tainted';
      max_uses: number | null; uses: number; review_flagged_at: Date | null;
    }>(
      `SELECT id, scope, disposition, state, max_uses, uses, review_flagged_at
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
          underReview: s.review_flagged_at !== null,
        });
      } else if (s.disposition === 'permit') {
        const remaining = s.max_uses === null ? null : s.max_uses - s.uses;
        out.push({
          sealId: s.id, scope: s.scope, disposition: 'permit', state: s.state,
          code: remaining !== null && remaining <= 0 ? CODES.permitExhausted : CODES.permitAvailable,
          remaining,
          underReview: s.review_flagged_at !== null,
        });
      } else {
        out.push({
          sealId: s.id, scope: s.scope, disposition: 'commit', state: s.state,
          code: CODES.commitMade,
          underReview: s.review_flagged_at !== null,
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
}): Promise<{ state: 'clawed' | 'pending'; signaturesNeeded?: number }> {
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
      claw_quorum: number; claw_jurisdiction: string | null;
    }>(
      `SELECT id, state, disposition, sealed_at, claw_authority, claw_evidence_floor,
              claw_cooling_off_s, claw_quorum, claw_jurisdiction
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
      quorum: s.claw_quorum === 2 ? 2 : 1,
      jurisdiction: s.claw_jurisdiction,
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

    // Where the reversing human is. Checked alongside authority and evidence
    // rather than after them, because it is the same kind of question: a
    // property of the credential that the caller cannot state about itself.
    if (required.jurisdiction != null && p.jurisdiction !== required.jurisdiction) {
      throw new ApiError(403, 'wrong_jurisdiction',
        `Reversing this determination requires a credential bound to `
        + `"${required.jurisdiction}"; this one is `
        + `${p.jurisdiction === null ? 'unbound' : `bound to "${p.jurisdiction}"`}.`,
        { required: required.jurisdiction, held: p.jurisdiction });
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

    // ── Quorum ────────────────────────────────────────────────────────
    //
    // Every bar above has now been cleared by THIS credential. A quorum adds a
    // requirement, it never relaxes one, so the second signer clears all of
    // them independently rather than inheriting the first signer's standing.
    //
    // Two signatures from the same key is one signature typed twice, so the
    // standing half must come from a different key. It also expires: a
    // dual-control decision that takes longer than a week is not one decision
    // made by two people, it is two unrelated decisions — and it bounds the
    // attacker holding one credential now who expects another later.
    if ((required.quorum ?? 1) === 2) {
      const { rows: standing } = await tx.query<{ key_id: string }>(
        `SELECT detail->>'key_id' AS key_id FROM seal_events
          WHERE seal_id = $1 AND kind = 'claw_pending'
            AND occurred_at > now() - ($2 || ' seconds')::interval
          ORDER BY occurred_at DESC`,
        [s.id, String(QUORUM_WINDOW_SECONDS)]);

      const other = standing.find((r) => r.key_id !== null && r.key_id !== p.keyId);
      if (!other) {
        await tx.query(
          `INSERT INTO seal_events
             (seal_id, workspace_id, kind, actor, evidence_sha256, evidence_class, detail)
           VALUES ($1,$2,'claw_pending',$3,$4,$5,$6::jsonb)`,
          [s.id, workspaceId, actor, args.evidenceSha256, args.evidenceClass,
            JSON.stringify({ key_id: p.keyId, hardened, pressure_tier: tier })]);
        // The determination is untouched. A quorum that never completes leaves
        // it standing, which is the safe direction.
        return { state: 'pending' as const, signaturesNeeded: 1 };
      }
    }

    await tx.query(
      `UPDATE seals SET state = 'clawed', settled_at = now() WHERE id = $1`, [s.id]);
    await tx.query(
      `INSERT INTO seal_events (seal_id, workspace_id, kind, actor, evidence_sha256, evidence_class, detail)
       VALUES ($1,$2,'clawed',$3,$4,$5,$6::jsonb)`,
      [s.id, workspaceId, actor, args.evidenceSha256, args.evidenceClass,
        JSON.stringify({ hardened, pressure_tier: tier, required, key_id: p.keyId })]);

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
 *
 * TWO MORE THINGS THE SCHEDULING BENCHMARK OF 10 SEPTEMBER 2026 FOUND.
 * First, fact expiry is a change that nothing writes. An attestation that
 * ran out under a standing determination left it `sealed` on evidence its
 * own owner had declared stale — 200 of 200, through five passes — because
 * neither trigger fires without a write. So every pass first marks due any
 * determination whose subject has an attestation that expired since the
 * determination was last examined: exact, and idempotent, because the
 * examination moves the cursor past the expiry. Second, under sustained
 * churn above the batch, due rows sort first and rows past their own expiry
 * never reach the front: 500 expired determinations stayed `sealed` through
 * ten overloaded passes and were recorded only when the feeds went quiet.
 * When due work fills an entire batch, a tenth of it is now given to rows
 * that are not due, so expiry is recorded at a bounded rate however busy
 * the feeds are; a batch with room in it is unchanged.
 */
interface ExamRow {
  id: string; subject_id: string; rule: Rule; state: string;
  grammar_version: string; expired: boolean; evaluation_due: boolean;
  disposition: Disposition; scope: string; sealed_at: Date;
}
interface Examination { next: string; guarded: unknown[]; loaded: FactRow[] | null }

/** Re-run one determination against the facts held now. Pure read. */
async function examine(
  db: Db, workspaceId: string, s: ExamRow, catalogue: Awaited<ReturnType<typeof loadCatalogue>>,
): Promise<Examination> {
  if (s.expired) {
    // Ran out. NOT an error — collapsing this into `lapsed` would count
    // every expiry as the institution having been wrong.
    return { next: 'expired', guarded: [], loaded: null };
  }
  if (!SUPPORTED_GRAMMAR_VERSIONS.has(s.grammar_version)) {
    // Cannot reproduce the semantics this was sealed under, so cannot check
    // it. Lost ground, not a disproof — and never a silent re-decision under
    // rules nobody agreed to.
    return { next: 'tainted', guarded: [], loaded: null };
  }
  const names = [...factsReferenced(s.rule)];
  const loaded = await loadFacts(db, workspaceId, s.subject_id, [...names, ...guardsOf(catalogue, names)]);
  // The same guard the seal applied. A finding of non-response that stood
  // on delivered mail does not survive the mail coming back.
  const { facts, withheld } = applyGuards(catalogue, loaded.facts, names);
  let next: string;
  try {
    next = classify(evaluate(s.rule, facts));
  } catch {
    // A type mismatch against changed attestations means the ground moved
    // in a way the rule cannot read. Lost ground, not a disproof.
    next = 'tainted';
  }
  return { next, guarded: withheld, loaded: loaded.rows };
}

/**
 * What moved under a determination that changed state: which committed
 * facts differ now — by name, source and admissibility class, never by
 * value — and the refusal pressure it stood under. On the record so that
 * the estimate of error among people who never complained (insight.ts) is
 * computable from records alone, by anyone who holds them.
 */
async function whatMoved(db: Db, sealId: string, loaded: FactRow[] | null): Promise<Record<string, unknown>> {
  const { rows: committed } = await db.query<{ fact: string; value_sha256: string; source: string; admissibility: string }>(
    'SELECT fact, value_sha256, source, admissibility FROM seal_facts WHERE seal_id = $1 ORDER BY fact', [sealId]);
  const now = new Map((loaded ?? []).map((r) => [r.fact, r]));
  const changed: Array<Record<string, unknown>> = [];
  for (const c of committed) {
    const n = now.get(c.fact);
    const was = { source: c.source, admissibility: c.admissibility };
    if (n === undefined) changed.push({ fact: c.fact, was, now: null });
    else if (valueDigest(n) !== c.value_sha256 || n.source !== c.source) {
      changed.push({ fact: c.fact, was, now: { source: n.source, admissibility: n.admissibility } });
    }
  }
  const { rows: p } = await db.query<{ attempts: string; sessions: string }>(
    `SELECT COALESCE(sum(attempts), 0) AS attempts, count(*) FILTER (WHERE declared) AS sessions
       FROM pressure WHERE seal_id = $1 AND last_at > now() - ($2 || ' days')::interval`,
    [sealId, String(PRESSURE_WINDOW_DAYS)]);
  return { changed, pressure: { attempts: Number(p[0]?.attempts ?? 0), sessions: Number(p[0]?.sessions ?? 0) } };
}

/** Record the outcome of an examination. Null when nothing changed or somebody else got there first. */
async function transition(
  tx: pg.PoolClient, workspaceId: string, s: ExamRow, ex: Examination,
): Promise<Reevaluation | null> {
  // The cursor advances whether or not anything changed. A pass that
  // examines a determination and leaves it alone has still examined it,
  // and recording that is what stops the sweep looping on its own head.
  const { rows: upd } = await tx.query<{ settled_at: Date | null }>(
    `UPDATE seals
        SET state = $2,
            settled_at = CASE WHEN $2 IN ('lapsed','expired') THEN now() ELSE settled_at END,
            last_evaluated_at = now(),
            evaluation_due = false
      WHERE id = $1 AND state = $3
      RETURNING settled_at`,
    [s.id, ex.next, s.state]);
  if (upd.length === 0) return null;  // somebody clawed it first; their record wins
  if (ex.next === s.state) return null;
  // cap-05. A refusal that lapsed stood for a measurable time; the
  // reversal carries its cost. Only a void `bind`: not an expiry, not a
  // taint, not a permit — see harm.ts for why each is excluded.
  const harm = ex.next === 'lapsed' && s.disposition === 'bind'
    ? harmToStored(harmOf({ scope: s.scope, sealedAt: s.sealed_at, reversedAt: upd[0]!.settled_at ?? new Date() }))
    : null;
  const moved = ex.next === 'lapsed' || ex.next === 'tainted' ? await whatMoved(tx, s.id, ex.loaded) : {};
  await tx.query(
    `INSERT INTO seal_events (seal_id, workspace_id, kind, detail)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [s.id, workspaceId, ex.next, JSON.stringify({ from: s.state,
      ...(ex.guarded.length > 0 ? { guarded: ex.guarded } : {}),
      ...(harm === null ? {} : { harm }),
      ...moved })]);
  return { sealId: s.id, from: s.state, to: ex.next };
}

/** How many of a subject's determinations a single write re-executes before handing the rest to the sweep. */
export const SYNC_REEXECUTION_CAP = 8;

/**
 * Correction at the moment of the write.
 *
 * The change-driven trigger marked a subject's determinations due and left
 * them for the next pass — up to a minute away, and behind whatever else
 * was due. But the write that moved the ground is a transaction, the
 * determinations it moves are a handful, and re-executing them here means
 * the fact and its consequence become visible together: no reader ever
 * sees the new fact beside the old refusal. Bounded by the cap, locked with
 * SKIP LOCKED so a pass already holding a row is left to finish it, and the
 * sweep remains the backstop for everything past the cap.
 */
export async function reexecuteSubject(
  tx: pg.PoolClient, workspaceId: string, subjectId: string, cap = SYNC_REEXECUTION_CAP,
): Promise<Reevaluation[]> {
  const { rows } = await tx.query<ExamRow>(
    `SELECT id, subject_id, rule, state, grammar_version,
            (expires_at IS NOT NULL AND expires_at <= now()) AS expired, evaluation_due,
            disposition, scope, sealed_at
       FROM seals
      WHERE workspace_id = $1 AND subject_id = $2 AND state IN ('sealed', 'tainted') AND evaluation_due
      ORDER BY sealed_at
      LIMIT $3
      FOR UPDATE SKIP LOCKED`,
    [workspaceId, subjectId, cap]);
  if (rows.length === 0) return [];
  const catalogue = await loadCatalogue(tx, workspaceId);
  const out: Reevaluation[] = [];
  for (const s of rows) {
    const moved = await transition(tx, workspaceId, s, await examine(tx, workspaceId, s, catalogue));
    if (moved !== null) out.push(moved);
  }
  return out;
}

/**
 * The third trigger: a fact that ran out under a standing determination.
 * Runs once per pass across every workspace BEFORE the pass decides which
 * workspaces have due work — the benchmark that found the hole was re-run
 * with this inside the per-workspace batch and found it again, because a
 * workspace with nothing else due never reached the batch. Exact and
 * idempotent: the examination moves the cursor past the expiry.
 */
export async function markFactExpiryDue(db: Db, workspaceId: string | null = null): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE seals s SET evaluation_due = true
       FROM attestations a
      WHERE ($1::text IS NULL OR s.workspace_id = $1)
        AND a.workspace_id = s.workspace_id AND a.subject_id = s.subject_id
        AND s.state IN ('sealed', 'tainted') AND NOT s.evaluation_due
        AND a.expires_at IS NOT NULL AND a.expires_at <= now()
        AND a.expires_at > COALESCE(s.last_evaluated_at, s.sealed_at)`,
    [workspaceId]);
  return rowCount ?? 0;
}

export async function reevaluate(workspaceId: string, limit = 100): Promise<SweepResult> {
  const pool = (await import('../db/pool.js')).getPool();
  await markFactExpiryDue(pool, workspaceId);

  type Row = ExamRow;
  const { rows } = await pool.query<Row>(
    `SELECT id, subject_id, rule, state, grammar_version,
            (expires_at IS NOT NULL AND expires_at <= now()) AS expired, evaluation_due,
            disposition, scope, sealed_at
       FROM seals
      WHERE workspace_id = $1 AND state IN ('sealed', 'tainted')
        AND (evaluation_due
             OR last_evaluated_at IS NULL
             OR (expires_at IS NOT NULL AND expires_at <= now()))
      ORDER BY evaluation_due DESC, last_evaluated_at NULLS FIRST
      LIMIT $2`,
    [workspaceId, limit]);
  // The reserved share. Only when due work fills the ENTIRE batch — so a
  // batch with room in it is still due-first and nothing waits that need
  // not — a tenth of it is given to rows that are not due: never examined,
  // or past their own expiry, least recently examined first. The due rows
  // they displace are the last in order and are next pass's first.
  const reserve = Math.floor(limit / 10);
  if (reserve > 0 && rows.length === limit && rows.every((r) => r.evaluation_due)) {
    const { rows: extra } = await pool.query<Row>(
      `SELECT id, subject_id, rule, state, grammar_version,
              (expires_at IS NOT NULL AND expires_at <= now()) AS expired, evaluation_due,
              disposition, scope, sealed_at
         FROM seals
        WHERE workspace_id = $1 AND state IN ('sealed', 'tainted') AND NOT evaluation_due
          AND (last_evaluated_at IS NULL OR (expires_at IS NOT NULL AND expires_at <= now()))
        ORDER BY last_evaluated_at NULLS FIRST
        LIMIT $2`,
      [workspaceId, reserve]);
    if (extra.length > 0) rows.splice(rows.length - extra.length, extra.length, ...extra);
  }

  const catalogue = await loadCatalogue(pool, workspaceId);
  const changes: Reevaluation[] = [];
  for (const s of rows) {
    const ex = await examine(pool, workspaceId, s, catalogue);
    const moved = await withTx((tx) => transition(tx, workspaceId, s, ex));
    if (moved !== null) changes.push(moved);
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
