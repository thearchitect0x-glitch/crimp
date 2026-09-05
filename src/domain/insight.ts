// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * The three measurements. This is what Crimp is for.
 *
 * Everything else in this codebase is machinery that exists so these numbers
 * can be computed. Each survived every prior-art sweep the design went through;
 * the mechanisms around them did not.
 *
 * A shared discipline, inherited from Ratchet's `structuring.ts` and
 * `agent-quality.ts`, applies to all three:
 *
 *   - Below a volume floor a rate is noise, and a noisy number presented
 *     confidently is worse than no number. A metric that cannot be computed
 *     honestly returns null and says why.
 *   - No composite score. A blended number hides the mechanism and invites
 *     gaming by suppressing whichever signal drags it down.
 *   - These are hints, not verdicts. Every one of them is a reason to look, and
 *     none of them is a finding.
 */
import type { Db } from '../db/pool.js';
import { thresholds, type Rule } from './rule.js';
import { PRESSURE_WINDOW_DAYS, tierOf } from './lifecycle.js';

/** Below this many determinations, a rate is noise. */
export const VOLUME_FLOOR = 20;

/* ── 1 · Source reliability ──────────────────────────────────────────── */

export interface SourceReliability {
  source: string;
  admissibility: string;
  /** Determinations that read a fact from this source. */
  seals: number;
  lapsed: number;
  tainted: number;
  /** lapsed / seals, or null below the volume floor. */
  lapseRate: number | null;
  note?: string;
}

/**
 * How often do determinations resting on this source turn out to be wrong?
 *
 * WHY THIS IS NOT AVAILABLE ANYWHERE ELSE. Institutions buy facts from bureaus,
 * KYC vendors, device fingerprinters and carrier APIs, and measure those
 * vendors against labels the vendors themselves helped produce. The measurement
 * is circular, and the circularity is the vulnerability: consensus-based trust
 * is exactly what synthetic identity cultivation is engineered to manufacture.
 * Seed a fact, let institutions cite one another until it looks corroborated,
 * and a consensus score rates the identity highly by construction.
 *
 * An outcome cannot be cultivated. A manufactured fact eventually stops
 * holding, and the source carrying it shows an elevated lapse rate before the
 * bust-out rather than after it.
 *
 * ATTRIBUTION IS SHARED AND THAT IS A REAL LIMIT. A seal that lapsed may have
 * read four sources, and all four are counted. This says which sources are
 * present when determinations collapse — it does not say which one caused it.
 * Treat a high rate as somewhere to look.
 */
export async function sourceReliability(
  db: Db, workspaceId: string, days = 90,
): Promise<SourceReliability[]> {
  const { rows } = await db.query<{
    source: string; admissibility: string;
    seals: string; lapsed: string; tainted: string;
  }>(
    `SELECT sf.source,
            sf.admissibility,
            count(DISTINCT sf.seal_id)                                        AS seals,
            count(DISTINCT sf.seal_id) FILTER (WHERE s.state = 'lapsed')      AS lapsed,
            count(DISTINCT sf.seal_id) FILTER (WHERE s.state = 'tainted')     AS tainted
       FROM seal_facts sf
       JOIN seals s ON s.id = sf.seal_id
      WHERE s.workspace_id = $1
        AND s.sealed_at > now() - ($2 || ' days')::interval
      GROUP BY sf.source, sf.admissibility
      ORDER BY sf.source`,
    [workspaceId, String(days)]);

  return rows.map((r) => {
    const seals = Number(r.seals);
    const lapsed = Number(r.lapsed);
    const enough = seals >= VOLUME_FLOOR;
    return {
      source: r.source,
      admissibility: r.admissibility,
      seals,
      lapsed,
      tainted: Number(r.tainted),
      lapseRate: enough ? lapsed / seals : null,
      ...(enough ? {} : {
        note: `Below the volume floor of ${VOLUME_FLOOR} determinations; a rate here would be noise.`,
      }),
    };
  });
}

/* ── 2 · The wrongful-denial quadrant ────────────────────────────────── */

export type Quadrant = 'normal' | 'contested_and_correct' | 'quiet_error' | 'wrong_and_resisted';

export interface QuadrantCounts {
  window: { days: number };
  normal: number;
  /** Pressure, premises held. A correct decision under attack — harden it. */
  contestedAndCorrect: number;
  /** Premises failed, nobody complained. Remediate without being asked. */
  quietError: number;
  /** Premises failed AND somebody had to fight. The number nothing else has. */
  wrongAndResisted: number;
  examined: number;
}

/**
 * Cross premise-failure with pressure and the fourth cell does not exist
 * anywhere else.
 *
 *                     premises held        premises failed
 *   low pressure      normal               QUIET ERROR
 *   high pressure     contested & correct  WRONG AND RESISTED
 *
 * `quietError` is the population every existing measurement of wrongful denial
 * cannot see. Medicare Advantage overturns 80.7% of appealed denials and only
 * 6.2% of denials are ever appealed; the error rate among the other 93.8% is
 * structurally unobservable, because if nobody appealed then nobody looked.
 * A lapse is the institution discovering it was wrong about somebody who never
 * said a word.
 *
 * `wrongAndResisted` is the liability cell. Complaints systems see the fighting
 * and never the wrongness; risk systems see outcomes and never count refused
 * re-attempts. Nobody joins them, because nobody holds both.
 */
export async function quadrant(
  db: Db, workspaceId: string, days = 90,
): Promise<QuadrantCounts> {
  const { rows } = await db.query<{
    id: string; state: string; attempts: string | null; sessions: string | null;
  }>(
    `SELECT s.id, s.state,
            COALESCE(sum(p.attempts), 0)                  AS attempts,
            count(p.*) FILTER (WHERE p.declared)          AS sessions
       FROM seals s
       LEFT JOIN pressure p
         ON p.seal_id = s.id
        AND p.last_at > now() - ($3 || ' days')::interval
      WHERE s.workspace_id = $1
        AND s.sealed_at   > now() - ($2 || ' days')::interval
      GROUP BY s.id, s.state`,
    [workspaceId, String(days), String(PRESSURE_WINDOW_DAYS)]);

  const out: QuadrantCounts = {
    window: { days },
    normal: 0, contestedAndCorrect: 0, quietError: 0, wrongAndResisted: 0,
    examined: rows.length,
  };

  for (const r of rows) {
    const pressed = tierOf({
      attempts: Number(r.attempts ?? 0),
      sessions: Number(r.sessions ?? 0),
    }) !== 'none';
    // `lapsed` is the premise failing. `clawed` is a person overruling, which
    // is a different event and deliberately not counted as the system being
    // wrong — somebody decided, and that decision is on the record.
    const failed = r.state === 'lapsed';

    if (failed && pressed) out.wrongAndResisted++;
    else if (failed) out.quietError++;
    else if (pressed) out.contestedAndCorrect++;
    else out.normal++;
  }
  return out;
}

/* ── 3 · Cliffs ──────────────────────────────────────────────────────── */

export interface Cliff {
  fact: string;
  op: string;
  threshold: number;
  /** Subjects currently sitting immediately below the line. */
  justBelow: number;
  /** And immediately above it. */
  justAbove: number;
  rulesUsingIt: number;
}

/**
 * Where the lines are, and how many people are standing either side of them.
 *
 * This does not tell you whether three is the right number of prior refunds.
 * Nothing can: that is a value judgment, and the fourteen-year-old problem
 * individual fairness is stuck on is precisely that nobody can derive it.
 *
 * What it tells you is how much human consequence is hanging on a number
 * somebody picked. *Four thousand denials at exactly three; four thousand one
 * hundred approvals at exactly two.* That is the argument that needs having and
 * currently cannot be had at all, because the rule is never written down
 * anywhere that can be counted against.
 *
 * Ratchet's `structuring.ts` compares two adjacent bands below a threshold to
 * find bunching in amounts. Same shape, pointed at rules.
 *
 * MEASURED OVER CURRENT ATTESTATIONS, not history — the historical value is
 * never stored, by design, so this describes the live population rather than
 * every decision ever made.
 */
export async function cliffs(
  db: Db, workspaceId: string, band = 1,
): Promise<Cliff[]> {
  const { rows: sealRows } = await db.query<{ rule: Rule }>(
    `SELECT rule FROM seals WHERE workspace_id = $1 AND state IN ('sealed', 'tainted')`,
    [workspaceId]);

  // Collapse identical boundaries: many seals share one policy line, and the
  // question is about the line, not about each time it was applied.
  const lines = new Map<string, { fact: string; op: string; value: number; n: number }>();
  for (const s of sealRows) {
    for (const t of thresholds(s.rule)) {
      const key = `${t.fact}|${t.op}|${t.value}`;
      const seen = lines.get(key);
      if (seen) seen.n++;
      else lines.set(key, { fact: t.fact, op: t.op, value: t.value, n: 1 });
    }
  }
  if (lines.size === 0) return [];

  const out: Cliff[] = [];
  for (const line of lines.values()) {
    const { rows } = await db.query<{ below: string; above: string }>(
      `SELECT count(*) FILTER (WHERE int_value >= $3 AND int_value < $4) AS below,
              count(*) FILTER (WHERE int_value >= $4 AND int_value <= $5) AS above
         FROM attestations
        WHERE workspace_id = $1 AND fact = $2 AND fact_type IN ('int', 'time')`,
      [workspaceId, line.fact, line.value - band, line.value, line.value + band]);
    out.push({
      fact: line.fact,
      op: line.op,
      threshold: line.value,
      justBelow: Number(rows[0]?.below ?? 0),
      justAbove: Number(rows[0]?.above ?? 0),
      rulesUsingIt: line.n,
    });
  }
  return out.sort((a, b) => (b.justBelow + b.justAbove) - (a.justBelow + a.justAbove));
}
