// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The one place `snake_case` on the wire meets `camelCase` in the domain.
 *
 * Both conventions are fine. Both leaking across this line is not: it produces
 * a codebase where you cannot tell, at a glance, whether an object came from a
 * request or from a query, and eventually somebody writes `sealed_by` into a
 * domain function or `clawAuthority` into a JSON response.
 *
 * Everything here is explicit rather than a generic key-rewriter. A generic one
 * would silently rename fields nobody intended it to, including fields added
 * later by somebody who never read this file.
 */
import type { SealResult, LookupResult } from '../domain/seal.js';
import type { ClawRule } from '../domain/authority.js';
import type { SourceReliability, QuadrantCounts, Cliff } from '../domain/insight.js';
import type { MintedKey } from '../domain/auth.js';
import type { Reason } from '../domain/explain.js';
import type { Proof, Disclosure } from '../domain/record.js';
import { toStored, type RegisteredRule } from '../domain/registry.js';
import type { CatalogueEntry } from '../domain/catalogue.js';
import type { Remedy } from '../domain/remedy.js';
import type { Clock, Timeliness } from '../domain/clocks.js';
import type { Finding } from '../domain/findings.js';
import { ApiError } from '../lib/errors.js';

/* ── Inbound ─────────────────────────────────────────────────────────── */

export interface WireClaw {
  authority: string;
  evidence_floor: string;
  cooling_off_seconds?: number;
  quorum?: number;
  jurisdiction?: string | null;
}

export function clawFromWire(w: WireClaw): ClawRule {
  return {
    authority: w.authority as ClawRule['authority'],
    evidenceFloor: w.evidence_floor as ClawRule['evidenceFloor'],
    coolingOffSeconds: w.cooling_off_seconds ?? 0,
    quorum: w.quorum === 2 ? 2 : 1,
    jurisdiction: w.jurisdiction ?? null,
  };
}

export interface WireFact {
  fact: string;
  type: string;
  value: boolean | number | string;
  source: string;
  asserted_at?: string;
  expires_at?: string | null;
}

export function factFromWire(w: WireFact): {
  fact: string; type: 'bool' | 'int' | 'str' | 'time';
  value: boolean | number | string; source: string;
  assertedAt?: Date; expiresAt?: Date | null;
} {
  const when = (s: string | undefined | null): Date | undefined => {
    if (s == null) return undefined;
    const d = new Date(s);
    // An unparseable timestamp is a caller bug. Silently substituting `now`
    // would put a fabricated assertion time on the record.
    if (Number.isNaN(d.getTime())) {
      throw new ApiError(400, 'invalid_request', `"${s}" is not a valid timestamp.`);
    }
    return d;
  };
  return {
    fact: w.fact,
    type: w.type as 'bool' | 'int' | 'str' | 'time',
    value: w.value,
    source: w.source,
    ...(w.asserted_at !== undefined ? { assertedAt: when(w.asserted_at) } : {}),
    ...(w.expires_at !== undefined ? { expiresAt: when(w.expires_at) ?? null } : {}),
  };
}

/* ── Outbound ────────────────────────────────────────────────────────── */

export function sealToWire(r: SealResult): Record<string, unknown> {
  return {
    seal_id: r.sealId,
    outcome: r.outcome,
    disposition: r.disposition,
    rule_hash: r.ruleHash,
    reason: r.reason,
    reasons: r.reasons.map(reasonToWire),
    expires_at: r.expiresAt?.toISOString() ?? null,
    rule_ref: r.ruleRef === null ? null : toStored(r.ruleRef),
    remedy: remedyToWire(r.remedy),
  };
}

/** A remedy on the wire. Rule literals and cells only — nothing observed. */
export function remedyToWire(r: Remedy | null): Record<string, unknown> | null {
  if (r === null) return null;
  return {
    target: r.target,
    exhaustive: r.exhaustive,
    evaluations: r.evaluations,
    sets: r.sets.map((set) => set.map((c) => ({
      fact: c.fact, fact_type: c.factType,
      constraints: c.constraints.map((k) => ({ path: k.path, op: k.op, value: k.value, truth: k.truth })),
    }))),
  };
}

export function clockToWire(c: Clock): Record<string, unknown> {
  return {
    clock_id: c.id, scope: c.scope, clock: c.name, authority: c.authority,
    started_at: c.startedAt.toISOString(), due_at: c.dueAt.toISOString(), status: c.status,
    met_at: c.metAt?.toISOString() ?? null, missed_at: c.missedAt?.toISOString() ?? null,
    resolved_at: c.resolvedAt?.toISOString() ?? null, seal_id: c.sealId,
  };
}

export function timelinessToWire(t: Timeliness): Record<string, unknown> {
  return {
    clock: t.clock, authority: t.authority, running: t.running, met: t.met, missed: t.missed,
    mean_hours_to_meet: t.meanHoursToMeet, mean_hours_late: t.meanHoursLate, unresolved: t.unresolved,
  };
}

export function findingToWire(f: Finding): Record<string, unknown> {
  return {
    finding_id: f.id, class: f.class, subject_kind: f.subjectKind, subject_id: f.subjectId,
    detail: f.detail, occurred_at: f.occurredAt.toISOString(),
  };
}

export function catalogueEntryToWire(e: CatalogueEntry): Record<string, unknown> {
  return {
    fact: e.fact, fact_type: e.factType, class: e.class,
    guarded_by: e.guardedBy, guard_value: e.guardValue, allowed_values: e.allowedValues,
    description: e.description, declared_by: e.declaredBy,
    declared_at: e.declaredAt.toISOString(),
  };
}

export function registeredRuleToWire(r: RegisteredRule): Record<string, unknown> {
  return {
    ...toStored(r),
    rule: r.rule,
    grammar_version: r.grammarVersion,
    scope: r.scope,
    committed_by: r.committedBy,
    committed_at: r.committedAt.toISOString(),
    note: r.note,
  };
}

/**
 * A reason on the wire. `value` is the rule's own literal and `path` locates
 * the clause inside it — neither says anything about the person. An observed
 * value only ever appears through `disclosureToWire`.
 */
function reasonToWire(r: Reason): Record<string, unknown> {
  return { path: r.path, fact: r.fact, op: r.op, value: r.value, truth: r.truth,
    polarity: r.polarity };
}

export function proofToWire(p: Proof): Record<string, unknown> {
  return {
    seal_id: p.sealId,
    scope: p.scope,
    disposition: p.disposition,
    state: p.state,
    rule: p.rule,
    rule_hash: p.ruleHash,
    grammar_version: p.grammarVersion,
    sealed_by: p.sealedBy,
    sealed_at: p.sealedAt.toISOString(),
    expires_at: p.expiresAt?.toISOString() ?? null,
    as_of: p.asOf?.toISOString() ?? null,
    rule_ref: p.ruleRef === null ? null : toStored(p.ruleRef),
    remedy: remedyToWire(p.remedy),
    review_flagged_at: p.reviewFlaggedAt?.toISOString() ?? null,
    reasons: p.reasons.map(reasonToWire),
    facts: p.facts.map((f) => ({
      fact: f.fact, fact_type: f.factType, value_sha256: f.valueSha256,
      source: f.source, admissibility: f.admissibility,
      asserted_at: f.assertedAt.toISOString(),
      attester: f.attester,
    })),
    events: p.events.map((e) => ({
      kind: e.kind, actor: e.actor, evidence_sha256: e.evidenceSha256,
      evidence_class: e.evidenceClass, occurred_at: e.occurredAt.toISOString(),
    })),
    verify: p.verify,
  };
}

export function disclosureToWire(d: Disclosure): Record<string, unknown> {
  return {
    seal_id: d.sealId,
    recorded_at: d.recordedAt.toISOString(),
    reasons: d.reasons.map((r) => ({
      ...reasonToWire(r),
      observed: r.observed,
      source: r.source,
      admissibility: r.admissibility,
      ...(r.wouldHaveNeeded !== undefined ? { would_have_needed: r.wouldHaveNeeded } : {}),
    })),
  };
}

/**
 * No `bound` boolean and no token.
 *
 * Crimp reports what has been determined; whether that permits an action is
 * the caller's judgement, made with its own policy. An empty list means
 * nothing has been decided — it does not mean "allowed".
 */
export function lookupToWire(r: LookupResult): Record<string, unknown> {
  return {
    determinations: r.determinations.map((d) => ({
      seal_id: d.sealId,
      scope: d.scope,
      disposition: d.disposition,
      state: d.state,
      code: d.code,
      ...(d.remaining !== undefined ? { remaining: d.remaining } : {}),
      under_review: d.underReview,
    })),
  };
}

export function sourcesToWire(rows: SourceReliability[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    source: r.source,
    admissibility: r.admissibility,
    seals: r.seals,
    lapsed: r.lapsed,
    tainted: r.tainted,
    lapse_rate: r.lapseRate,
    ...(r.note !== undefined ? { note: r.note } : {}),
  }));
}

export function quadrantToWire(q: QuadrantCounts): Record<string, unknown> {
  return {
    window: { days: q.window.days },
    examined: q.examined,
    normal: q.normal,
    contested_and_correct: q.contestedAndCorrect,
    quiet_error: q.quietError,
    wrong_and_resisted: q.wrongAndResisted,
  };
}

export function cliffsToWire(rows: Cliff[]): Record<string, unknown>[] {
  return rows.map((c) => ({
    fact: c.fact,
    op: c.op,
    threshold: c.threshold,
    just_below: c.justBelow,
    just_above: c.justAbove,
    rules_using_it: c.rulesUsingIt,
  }));
}

export function keyToWire(k: MintedKey): Record<string, unknown> {
  return {
    key_id: k.id,
    // Returned once. There is no endpoint that can show it again.
    key: k.key,
    authority: k.authority,
    scopes: k.scopes,
  };
}
