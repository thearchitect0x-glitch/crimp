// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-05 · What a reversal cost the person, in days.
 *
 * A refusal that lapses — its premises withdrew their own support — stood
 * for a measurable period. That period is the harm this module computes:
 * days without coverage, and the days the programme's rule restores. It is
 * attached to the `lapsed` event, so the reversal carries its own cost and
 * the ledger is a query over events rather than a table somebody maintains.
 *
 * WHAT IT IS NOT. It is not a finding of fault. A determination lapses when
 * the facts change, and the record cannot tell a correction of an error from
 * a change in the world; both look like a fact moving. Whether the refusal
 * was *wrongful* is for an adjudication (capability 6) or a person to say.
 * What the record CAN say exactly is how long it stood, which is what a
 * corrective-action rule needs.
 *
 * ONLY A VOID REFUSAL. A `bind` that lapsed. Not an expiry (it ran out, on
 * its own terms), not a taint (the ground was lost, not disproved), not a
 * claw (a person overruled it and owns that judgement), and not a `permit` —
 * a grant withdrawn is a loss too, but it is not a wrongful denial and the
 * restoration rules cited here do not speak to it.
 */
import { getPool } from '../db/pool.js';
import { requireScope, type Principal } from './auth.js';
import { RESTORATION } from './restoration.config.js';
import { programmeOf } from './notice.config.js';

export interface Harm {
  programme: string;
  /** From the refusal taking effect to its reversal, in whole days (floor). */
  daysWithoutCoverage: number;
  /** The days the programme's rule restores: the same, capped by its window. */
  daysOwed: number;
  /** The window that capped it, in days, or null if the rule restores to the action date. */
  windowDays: number | null;
  authority: string | null;
  refusedAt: string;
  reversedAt: string;
}

const DAY = 864e5;

/**
 * Pure. Fixed dates in, fixed numbers out. A programme with no restoration
 * config still gets its days counted; only the cap is unknown, and that is
 * said with `windowDays: null` and no authority rather than a guessed number.
 */
export function harmOf(args: { scope: string; sealedAt: Date; reversedAt: Date }): Harm {
  const programme = programmeOf(args.scope);
  const cfg = RESTORATION[programme];
  const days = Math.max(0, Math.floor((args.reversedAt.getTime() - args.sealedAt.getTime()) / DAY));
  const windowDays = cfg?.windowDays ?? null;
  return {
    programme,
    daysWithoutCoverage: days,
    daysOwed: windowDays === null ? days : Math.min(days, windowDays),
    windowDays,
    authority: cfg?.authority ?? null,
    refusedAt: args.sealedAt.toISOString(),
    reversedAt: args.reversedAt.toISOString(),
  };
}

/** The wire/JSON shape stored on the event. snake_case because it lives in the record's events. */
export function harmToStored(h: Harm): Record<string, unknown> {
  return {
    programme: h.programme,
    days_without_coverage: h.daysWithoutCoverage,
    days_owed: h.daysOwed,
    window_days: h.windowDays,
    authority: h.authority,
    refused_at: h.refusedAt,
    reversed_at: h.reversedAt,
  };
}

export interface HarmLedgerRow {
  programme: string;
  /** The registered rule id where there was one, else the rule hash. */
  rule: string;
  /** YYYY-MM of the reversal. */
  month: string;
  reversals: number;
  daysWithoutCoverage: number;
  daysOwed: number;
}

/**
 * Totals by programme, rule and month. A query over `lapsed` events that
 * carry harm — nothing is accumulated anywhere else, so the ledger cannot
 * drift from the events it is made of.
 */
export async function harmLedger(p: Principal, days = 365): Promise<HarmLedgerRow[]> {
  requireScope(p, 'insight:read');
  const { rows } = await getPool().query<{
    programme: string; rule: string; month: string; reversals: string; dwc: string; owed: string;
  }>(
    `SELECT split_part(s.scope, '.', 1)                                   AS programme,
            coalesce(s.rule_ref->>'rule_id', left(s.rule_hash, 16))        AS rule,
            to_char(date_trunc('month', e.occurred_at), 'YYYY-MM')         AS month,
            count(*)                                                       AS reversals,
            sum((e.detail->'harm'->>'days_without_coverage')::bigint)      AS dwc,
            sum((e.detail->'harm'->>'days_owed')::bigint)                  AS owed
       FROM seal_events e JOIN seals s ON s.id = e.seal_id
      WHERE e.workspace_id = $1 AND e.kind = 'lapsed' AND e.detail ? 'harm'
        AND e.occurred_at > now() - ($2 || ' days')::interval
      GROUP BY 1, 2, 3 ORDER BY 3 DESC, 1, 2`,
    [p.workspaceId, String(days)]);
  return rows.map((r) => ({
    programme: r.programme, rule: r.rule, month: r.month, reversals: Number(r.reversals),
    daysWithoutCoverage: Number(r.dwc), daysOwed: Number(r.owed),
  }));
}
