-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- The correction channel did not reach past the hundredth determination.
--
-- `reevaluate()` selected `ORDER BY sealed_at LIMIT 100`. Seals that do not
-- change state stay at the front of that ordering forever, so the sweep
-- re-examined the same oldest hundred on every pass and never reached the
-- hundred-and-first. Measured before this migration was written: 105
-- determinations, the facts under the newest one changed, five complete
-- sweeps, still `sealed`.
--
-- That is worse than a sweep that never ran. A sweep that never runs is
-- visibly missing. This one returns quickly, reports changes, passes its
-- tests, and silently stops correcting after the hundredth person.
--
-- Two columns make the sweep a sweep:
--
--   last_evaluated_at  advances on every row EXAMINED, not every row changed.
--                      That is what makes the cursor move: ordering by it
--                      least-recent-first guarantees every determination is
--                      eventually visited, and max(now() - last_evaluated_at)
--                      becomes a measurable worst-case correction latency
--                      rather than an article of faith.
--
--   evaluation_due     set when an attestation lands for a subject, so a
--                      determination whose ground has actually moved jumps
--                      the queue instead of waiting its turn behind millions
--                      of unchanged ones.
--
-- WHY BOTH, AND NOT EITHER ALONE. Change-driven work alone cannot see expiry:
-- nothing is attested when a determination simply runs out, so no flag is
-- ever set. Time-driven work alone cannot scale: a state with seventy million
-- enrollees cannot re-examine every determination on a cycle short enough to
-- matter. The dirty flag carries correction; the cursor carries completeness
-- and expiry. Neither is redundant.

ALTER TABLE seals ADD COLUMN last_evaluated_at TIMESTAMPTZ;
ALTER TABLE seals ADD COLUMN evaluation_due BOOLEAN NOT NULL DEFAULT true;

-- Dirty first, then least recently examined, nulls (never examined) ahead of
-- everything. Partial, because a settled determination is never swept again.
CREATE INDEX seals_sweep_idx
  ON seals (workspace_id, evaluation_due DESC, last_evaluated_at NULLS FIRST)
  WHERE state IN ('sealed', 'tainted');

-- Marking dirty is keyed by subject: an attestation names a subject, and that
-- subject's determinations are few. Filtering further by which facts a rule
-- actually reads would be more precise and is not worth an index — a
-- re-evaluation that changes nothing is idempotent and cheap.
CREATE INDEX seals_subject_open_idx ON seals (workspace_id, subject_id)
  WHERE state IN ('sealed', 'tainted');
