// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Breadth: one session, many people.
 *
 * Pressure (lifecycle.ts) is counted per determination, so it sees a party
 * who keeps coming back about one person. It cannot see a party who comes
 * back once each about many — the shape of an enumeration, a search across
 * identifiers for whoever is not bound. Hardening every touched
 * determination would answer that by punishing the people enumerated. So
 * the response is a FINDING about the session, not about any person: the
 * institution is told which declared session was refused across how many
 * distinct determinations, and decides what to do with the credential
 * behind it. Enumeration detection by distinct targets per session is
 * ordinary security practice; what is particular here is only that it is
 * kept apart from the per-determination pressure that hardens, so that a
 * third party's breadth never raises the bar against the people it touched.
 */
import { type Db } from '../db/pool.js';
import { PRESSURE_WINDOW_DAYS } from './lifecycle.js';
import { recordFinding } from './findings.js';

export const BREADTH = {
  /** Distinct determinations one declared session must have been refused across. */
  distinctDeterminations: 10,
  windowDays: PRESSURE_WINDOW_DAYS,
} as const;

/** Called by the sweep. One finding per session per day; returns how many were new. */
export async function probingBreadth(db: Db): Promise<number> {
  const { rows } = await db.query<{ workspace_id: string; session: string; breadth: string; attempts: string }>(
    `SELECT s.workspace_id, p.session, count(DISTINCT p.seal_id) AS breadth, sum(p.attempts) AS attempts
       FROM pressure p JOIN seals s ON s.id = p.seal_id
      WHERE p.declared AND p.last_at > now() - ($1 || ' days')::interval
      GROUP BY s.workspace_id, p.session
     HAVING count(DISTINCT p.seal_id) >= $2`,
    [String(BREADTH.windowDays), BREADTH.distinctDeterminations]);
  const day = new Date().toISOString().slice(0, 10);
  let fresh = 0;
  for (const r of rows) {
    const f = await recordFinding(db, r.workspace_id, {
      class: 'probing_breadth', subjectKind: 'session', subjectId: r.session,
      detail: { day, determinations: Number(r.breadth), attempts: Number(r.attempts), window_days: BREADTH.windowDays,
        note: 'about the session, not about any person; no determination is hardened by this' },
    });
    if (f !== null) fresh++;
  }
  return fresh;
}
