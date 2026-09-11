// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
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
  /**
   * The same population split by whether anybody ever came back, rather
   * than by tier: the tier's threshold of three attempts puts a person who
   * asked once or twice into the "quiet" cell, and the estimate below
   * needs the people who asked never.
   */
  attempts: { zero: { examined: number; lapsed: number }; some: { examined: number; lapsed: number } };
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
 * cannot see. In 2022 Medicare Advantage overturned 83.2% of appealed denials,
 * and only about 10% of denials were ever appealed (KFF analysis of CMS data).
 * The error rate among the other ~90% is structurally unobservable, because if
 * nobody appealed then nobody looked.
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
    attempts: { zero: { examined: 0, lapsed: 0 }, some: { examined: 0, lapsed: 0 } },
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
    const bucket = Number(r.attempts ?? 0) === 0 ? out.attempts.zero : out.attempts.some;
    bucket.examined++;
    if (failed) bucket.lapsed++;
  }
  return out;
}

/* ── 2a · The error rate among people who never complained ───────────── */

/** Fewer lapses among the people who fought than this, and the feed share is anecdote. */
export const ESTIMATE_MIN_FOUGHT_LAPSES = 20;

export interface QuietErrorEstimate {
  window: { days: number };
  zeroAttempt: { n: number; lapsed: number; lapsedViaFeed: number; lapsedViaSelf: number; unattributed: number };
  fought: { n: number; lapsed: number; lapsedViaFeed: number; lapsedViaSelf: number; unattributed: number };
  /** Of the lapses among people who fought, the share whose correction came through a source other than the person. */
  feedShareAmongFought: number | null;
  /** Lapses over the zero-attempt population: the lower bound the record shows directly. */
  zeroAttemptLapseRate: number | null;
  /** feed-corrected lapses among the zero-attempt population, divided by the feed share among the fought, over the zero-attempt population. */
  calibratedRate: number | null;
  minimumFoughtLapses: number;
  assumptions: readonly string[];
}

export const ESTIMATE_ASSUMPTIONS = [
  'A person who pushed back and was wrongly refused supplied the evidence: discovery among the fought is near complete. Where it is not, this estimate is LOW.',
  'A fact that moved in the world without any error was corrected through a feed and is counted as one: this estimate is HIGH by the world-change rate.',
  'Feeds do not know who complained, so their discovery rate is the same for the people who never did.',
] as const;

/**
 * The quiet-error rate is a lower bound: a wrong refusal lapses only when a
 * correcting fact arrives, and for a person who never pushed back that only
 * happens through the institution's own feeds. The record holds the
 * calibrator — the admissibility class of the attestation that corrected
 * each lapsed determination, written on the lapsed event — so the feed
 * discovery rate can be measured among the people who fought, for whom
 * discovery is near complete, and applied to the people who never did.
 * A two-list estimate in the manner of capture–recapture, where the lists
 * are the person's own submission and the institution's feeds.
 */
export async function quietErrorEstimate(
  db: Db, workspaceId: string, days = 90, opts: { minFoughtLapses?: number } = {},
): Promise<QuietErrorEstimate> {
  const minimum = opts.minFoughtLapses ?? ESTIMATE_MIN_FOUGHT_LAPSES;
  const { rows } = await db.query<{ state: string; attempts: string | null; detail: Record<string, unknown> | null }>(
    `SELECT s.state,
            (SELECT sum(p.attempts) FROM pressure p WHERE p.seal_id = s.id
               AND p.last_at > now() - ($3 || ' days')::interval) AS attempts,
            (SELECT e.detail FROM seal_events e WHERE e.seal_id = s.id AND e.kind = 'lapsed'
              ORDER BY e.occurred_at DESC LIMIT 1) AS detail
       FROM seals s
      WHERE s.workspace_id = $1 AND s.disposition = 'bind'
        AND s.sealed_at > now() - ($2 || ' days')::interval`,
    [workspaceId, String(days), String(PRESSURE_WINDOW_DAYS)]);
  const cell = () => ({ n: 0, lapsed: 0, lapsedViaFeed: 0, lapsedViaSelf: 0, unattributed: 0 });
  const zero = cell(); const fought = cell();
  for (const r of rows) {
    const c = Number(r.attempts ?? 0) === 0 ? zero : fought;
    c.n++;
    if (r.state !== 'lapsed') continue;
    c.lapsed++;
    const changed = Array.isArray(r.detail?.['changed']) ? (r.detail!['changed'] as Array<{ now: { admissibility: string } | null }>) : [];
    const classes = changed.map((x) => x.now?.admissibility ?? null).filter((x): x is string => x !== null);
    if (classes.length === 0) c.unattributed++;
    else if (classes.some((k) => k !== 'self')) c.lapsedViaFeed++;
    else c.lapsedViaSelf++;
  }
  const attributedFought = fought.lapsedViaFeed + fought.lapsedViaSelf;
  const share = attributedFought >= minimum && attributedFought > 0 ? fought.lapsedViaFeed / attributedFought : null;
  return {
    window: { days }, zeroAttempt: zero, fought,
    feedShareAmongFought: share,
    zeroAttemptLapseRate: zero.n > 0 ? zero.lapsed / zero.n : null,
    calibratedRate: share !== null && share > 0 && zero.n > 0 ? (zero.lapsedViaFeed / share) / zero.n : null,
    minimumFoughtLapses: minimum,
    assumptions: ESTIMATE_ASSUMPTIONS,
  };
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
