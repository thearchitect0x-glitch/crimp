// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-03 · Clocks: what the programme owes the person, and whether it paid.
 *
 * A clock STARTS from an attested event — "the application was received on
 * this date" is a claim by a named source, like every fact here, and the
 * caller says when. It is MET by something already on the record: a
 * determination sealed for the subject in scope, or an attestation of a named
 * fact (a hearing ruling). It is MISSED when the due date passes first. The
 * sweep advances it; nothing else does.
 *
 * WHAT A CLOCK IS NOT. It is not a fact a rule can read, and the evaluator
 * cannot see it. A rule that could read "missed" could turn the agency's
 * lateness into the person's refusal. A missed clock is a FINDING, addressed
 * to the institution, and the record about the person is untouched — there
 * is no code path from this table to a seal's state.
 *
 * WHAT MEETS A DETERMINATION CLOCK, HONESTLY. Any seal for the subject in or
 * around the clock's scope — a permit or a bind. A favourable outcome that an
 * institution does not seal as a permit leaves no record, and so is invisible
 * to the clock as it is to everything else. An institution that wants its
 * timeliness measured seals its grants too.
 */
import { withTx, getPool, type Db } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { blindAliases, type MergeStrength } from '../lib/blind.js';
import { resolveForWrite, resolveForRead } from './subject.js';
import { validateScope } from './scope.js';
import { requireScope, type Principal } from './auth.js';
import { recordFinding } from './findings.js';
import { CLOCKS, CLOCK_NAMES, type ClockDefinition } from './clocks.config.js';

export type ClockStatus = 'running' | 'met' | 'missed';

export interface Clock {
  id: string;
  scope: string;
  name: string;
  authority: string;
  startedAt: Date;
  dueAt: Date;
  status: ClockStatus;
  metAt: Date | null;
  missedAt: Date | null;
  resolvedAt: Date | null;
  sealId: string | null;
}

interface Row {
  id: string; scope: string; name: string; started_at: Date; due_at: Date; status: ClockStatus;
  met_at: Date | null; missed_at: Date | null; resolved_at: Date | null; seal_id: string | null;
}
const COLS = 'id, scope, name, started_at, due_at, status, met_at, missed_at, resolved_at, seal_id';
const fromRow = (r: Row): Clock => ({
  id: r.id, scope: r.scope, name: r.name, authority: CLOCKS[r.name]?.authority ?? 'unknown',
  startedAt: r.started_at, dueAt: r.due_at, status: r.status,
  metAt: r.met_at, missedAt: r.missed_at, resolvedAt: r.resolved_at, sealId: r.seal_id,
});

export function definitionOf(name: string): ClockDefinition {
  const def = CLOCKS[name];
  if (def === undefined) {
    throw new ApiError(400, 'unknown_clock',
      `"${name}" is not a clock this system knows. Known: ${CLOCK_NAMES.join(', ')}.`,
      { name, known: CLOCK_NAMES });
  }
  return def;
}

/**
 * Start a clock. Idempotent while it runs: a second start of the same clock
 * for the same subject and scope returns the running one rather than a
 * second deadline nobody asked for.
 */
export async function startClock(p: Principal, args: {
  aliases: unknown; scope: string; clock: string; startedAt: Date;
}, strengths: Readonly<Record<string, MergeStrength>>): Promise<Clock & { outcome: 'started' | 'already_running' }> {
  requireScope(p, 'attestations:write');
  const def = definitionOf(args.clock);
  const scope = validateScope(args.scope);
  if (!(args.startedAt instanceof Date) || Number.isNaN(args.startedAt.getTime())) {
    throw new ApiError(400, 'invalid_request', 'started_at must be a timestamp.');
  }
  // A start in the future is not an event that happened. A minute of slack
  // for clocks that disagree; beyond that it is a units or timezone mistake.
  if (args.startedAt.getTime() > Date.now() + 60_000) {
    throw new ApiError(400, 'invalid_request', 'started_at is in the future; a clock starts from an event that has happened.');
  }
  const dueAt = new Date(args.startedAt.getTime() + def.hours * 3600 * 1000);
  const aliases = blindAliases(p.workspaceId, args.aliases, strengths);

  return withTx(async (tx) => {
    const { subjectId } = await resolveForWrite(tx, p.workspaceId, aliases, { doing: 'starting a clock' });
    const { rows: running } = await tx.query<Row>(
      `SELECT ${COLS} FROM clocks
        WHERE workspace_id = $1 AND subject_id = $2 AND scope = $3 AND name = $4 AND status = 'running'`,
      [p.workspaceId, subjectId, scope, args.clock]);
    if (running[0]) return { ...fromRow(running[0]), outcome: 'already_running' as const };

    const id = newId('clk');
    const { rows } = await tx.query<Row>(
      `INSERT INTO clocks (id, workspace_id, subject_id, scope, name, started_at, due_at,
                           started_by, started_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [id, p.workspaceId, subjectId, scope, args.clock, args.startedAt, dueAt, p.authority, p.keyId]);
    return { ...fromRow(rows[0]!), outcome: 'started' as const };
  });
}

/** When the thing the clock waits for happened, if it has. */
async function metAt(db: Db, workspaceId: string, c: {
  subject_id: string; scope: string; started_at: Date;
}, def: ClockDefinition): Promise<{ at: Date; sealId: string | null } | null> {
  if (def.metBy.kind === 'seal') {
    // In scope, or around it: a determination at an ancestor scope covers the
    // clock's, and one at a descendant is inside it. Either is the
    // determination the person was waiting for. `starts_with`, not LIKE —
    // scope names carry underscores, which LIKE would read as wildcards.
    const { rows } = await db.query<{ id: string; sealed_at: Date }>(
      `SELECT id, sealed_at FROM seals
        WHERE workspace_id = $1 AND subject_id = $2 AND sealed_at >= $3
          AND (scope = '*' OR scope = $4
               OR starts_with($4, scope || '.') OR starts_with(scope, $4 || '.'))
        ORDER BY sealed_at LIMIT 1`,
      [workspaceId, c.subject_id, c.started_at, c.scope]);
    return rows[0] ? { at: rows[0].sealed_at, sealId: rows[0].id } : null;
  }
  const { rows } = await db.query<{ asserted_at: Date }>(
    `SELECT asserted_at FROM attestations
      WHERE workspace_id = $1 AND subject_id = $2 AND fact = $3 AND asserted_at >= $4`,
    [workspaceId, c.subject_id, def.metBy.fact, c.started_at]);
  return rows[0] ? { at: rows[0].asserted_at, sealId: null } : null;
}

export interface ClockAdvance { met: number; missed: number; examined: number }

/**
 * Advance every running clock in a workspace. Called by the sweep.
 *
 * Met if the owed thing happened on or before due. Otherwise missed once the
 * database's clock — not this process's — says due has passed, with a
 * finding, and with `resolved_at` if the owed thing happened late. Otherwise
 * still running. Each transition is guarded by `status = 'running'`, so two
 * workers cannot both make it.
 */
export async function advanceClocks(workspaceId: string): Promise<ClockAdvance> {
  const pool = getPool();
  const { rows } = await pool.query<Row & { subject_id: string; overdue: boolean }>(
    `SELECT ${COLS}, subject_id, (due_at < now()) AS overdue FROM clocks
      WHERE workspace_id = $1 AND status = 'running' ORDER BY due_at LIMIT 1000`,
    [workspaceId]);
  const out: ClockAdvance = { met: 0, missed: 0, examined: rows.length };

  for (const c of rows) {
    const def = CLOCKS[c.name];
    if (def === undefined) continue;  // a name from a future config; leave it running
    const done = await metAt(pool, workspaceId, c, def);

    if (done !== null && done.at <= c.due_at) {
      const { rowCount } = await pool.query(
        `UPDATE clocks SET status = 'met', met_at = $2, seal_id = $3
          WHERE id = $1 AND status = 'running'`, [c.id, done.at, done.sealId]);
      if (rowCount) out.met++;
      continue;
    }
    if (!c.overdue) continue;

    await withTx(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE clocks SET status = 'missed', missed_at = now(), resolved_at = $2, seal_id = $3
          WHERE id = $1 AND status = 'running'`,
        [c.id, done?.at ?? null, done?.sealId ?? null]);
      if (!rowCount) return;
      out.missed++;
      await recordFinding(tx, workspaceId, {
        class: 'agency_timeliness', subjectKind: 'clock', subjectId: c.id,
        detail: {
          clock: c.name, scope: c.scope, authority: def.authority,
          started_at: c.started_at.toISOString(), due_at: c.due_at.toISOString(),
          resolved_at: done?.at.toISOString() ?? null,
          late_hours: done ? Math.round((done.at.getTime() - c.due_at.getTime()) / 36e5) : null,
        },
      });
    });
  }
  return out;
}

/** A missed clock that is later resolved records how late. The sweep fills it in. */
export async function resolveMissed(workspaceId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<Row & { subject_id: string }>(
    `SELECT ${COLS}, subject_id FROM clocks
      WHERE workspace_id = $1 AND status = 'missed' AND resolved_at IS NULL LIMIT 1000`,
    [workspaceId]);
  let n = 0;
  for (const c of rows) {
    const def = CLOCKS[c.name];
    if (def === undefined) continue;
    const done = await metAt(pool, workspaceId, c, def);
    if (done === null) continue;
    const { rowCount } = await pool.query(
      `UPDATE clocks SET resolved_at = $2, seal_id = $3 WHERE id = $1 AND resolved_at IS NULL`,
      [c.id, done.at, done.sealId]);
    if (rowCount) n++;
  }
  return n;
}

/** The clocks for one subject. Read through aliases, never by id. */
export async function clocksFor(p: Principal, args: { aliases: unknown },
  strengths: Readonly<Record<string, MergeStrength>>): Promise<Clock[]> {
  requireScope(p, 'determinations:read');
  const aliases = blindAliases(p.workspaceId, args.aliases, strengths);
  return withTx(async (tx) => {
    // A READ. `resolveForRead` attaches nothing: `resolveForWrite` binds every
    // presented alias to the subject it finds even with `create: false`, which
    // would let a key holding only `determinations:read` bind a shared device
    // to a refused person. Found by the security sweep; the hot-path lookup
    // already did this right.
    const subjectId = await resolveForRead(tx, p.workspaceId, aliases);
    if (subjectId === null) {
      throw new ApiError(404, 'unknown_subject', 'No subject matches these aliases.');
    }
    const { rows } = await tx.query<Row>(
      `SELECT ${COLS} FROM clocks WHERE workspace_id = $1 AND subject_id = $2 ORDER BY started_at DESC`,
      [p.workspaceId, subjectId]);
    return rows.map(fromRow);
  });
}

export interface Timeliness {
  clock: string;
  authority: string;
  running: number;
  met: number;
  missed: number;
  /** Hours from start to met, averaged over met clocks. Null with none. */
  meanHoursToMeet: number | null;
  /** Hours past due, averaged over missed clocks that were later resolved. */
  meanHoursLate: number | null;
  unresolved: number;
}

/**
 * The number 42 CFR 433.112(b)(15) asks for: is the programme meeting its own
 * deadlines, measured, per clock, on an ongoing basis.
 */
export async function timeliness(p: Principal, days = 90): Promise<Timeliness[]> {
  requireScope(p, 'insight:read');
  const { rows } = await getPool().query<{
    name: string; running: string; met: string; missed: string;
    mean_to_meet: string | null; mean_late: string | null; unresolved: string;
  }>(
    `SELECT name,
            count(*) FILTER (WHERE status = 'running')  AS running,
            count(*) FILTER (WHERE status = 'met')      AS met,
            count(*) FILTER (WHERE status = 'missed')   AS missed,
            avg(EXTRACT(EPOCH FROM (met_at - started_at)) / 3600) FILTER (WHERE status = 'met') AS mean_to_meet,
            avg(EXTRACT(EPOCH FROM (resolved_at - due_at)) / 3600)
              FILTER (WHERE status = 'missed' AND resolved_at IS NOT NULL) AS mean_late,
            count(*) FILTER (WHERE status = 'missed' AND resolved_at IS NULL) AS unresolved
       FROM clocks
      WHERE workspace_id = $1 AND started_at > now() - ($2 || ' days')::interval
      GROUP BY name ORDER BY name`,
    [p.workspaceId, String(days)]);
  return rows.map((r) => ({
    clock: r.name, authority: CLOCKS[r.name]?.authority ?? 'unknown',
    running: Number(r.running), met: Number(r.met), missed: Number(r.missed),
    meanHoursToMeet: r.mean_to_meet === null ? null : Math.round(Number(r.mean_to_meet)),
    meanHoursLate: r.mean_late === null ? null : Math.round(Number(r.mean_late)),
    unresolved: Number(r.unresolved),
  }));
}
