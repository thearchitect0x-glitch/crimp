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
import { ApiError } from '../lib/errors.js';

/* ── Inbound ─────────────────────────────────────────────────────────── */

export interface WireClaw {
  authority: string;
  evidence_floor: string;
  cooling_off_seconds?: number;
}

export function clawFromWire(w: WireClaw): ClawRule {
  return {
    authority: w.authority as ClawRule['authority'],
    evidenceFloor: w.evidence_floor as ClawRule['evidenceFloor'],
    coolingOffSeconds: w.cooling_off_seconds ?? 0,
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
    expires_at: r.expiresAt?.toISOString() ?? null,
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
