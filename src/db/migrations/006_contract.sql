-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Four things that shape the API contract, settled before anybody integrates.
-- Three are defects. The fourth is the measurement the product is for.

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · A seal could be created twice.
--
-- In the sibling of a product that exists because retries create duplicates.
-- An agent whose POST timed out and retried created two determinations. Mostly
-- harmless for a `bind`; for a `permit` with max_uses = 1 it grants two uses,
-- which is exactly the "same one-time grant issued twice" loss this product
-- claims to prevent. It also inflates source reliability, which counts
-- distinct seals.
--
-- Required, not optional. An at-most-once guarantee callers can forget to opt
-- into is not a guarantee, and it costs the caller one field. Enforced by a
-- unique index rather than by application logic — the same reasoning Ratchet
-- records for its own.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE seals ADD COLUMN idempotency_key TEXT;
UPDATE seals SET idempotency_key = id WHERE idempotency_key IS NULL;
ALTER TABLE seals ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX seals_idempotency_idx ON seals (workspace_id, idempotency_key);

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · No seal recorded which grammar evaluated it.
--
-- The reproducibility claim is "re-run the sealed rule and get the same
-- answer". A seal stored the rule and its hash but nothing about the semantics
-- applied to it, so the promise that the grammar "may be widened where existing
-- rules keep their meaning" had no mechanism behind it. The moment the
-- evaluator changes at all, nobody can prove which semantics produced a
-- determination — a hole in the load-bearing wall of a system whose pitch is
-- examinable decisions.
--
-- The evaluator refuses a version it cannot reproduce rather than guessing. A
-- determination it cannot re-check becomes `tainted`, never `lapsed`.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE seals ADD COLUMN grammar_version TEXT NOT NULL DEFAULT '1';

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · A determination bound forever.
--
-- A refund denial sealed today still stood in 2031 unless somebody clawed it.
-- That is a fairness problem and a storage-limitation problem, and an odd one
-- for a product whose thesis is that decisions should be answerable.
--
-- `expired` is a distinct state from `lapsed` and `clawed` because they mean
-- different things. Lapsed means the institution was wrong. Expired means the
-- determination simply ran out. Collapsing them would corrupt the quadrant by
-- counting every expiry as an error.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE seals ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE seals DROP CONSTRAINT seals_state_check;
ALTER TABLE seals ADD CONSTRAINT seals_state_check
  CHECK (state IN ('sealed', 'tainted', 'lapsed', 'clawed', 'expired'));
ALTER TABLE seal_events DROP CONSTRAINT seal_events_kind_check;
ALTER TABLE seal_events ADD CONSTRAINT seal_events_kind_check
  CHECK (kind IN ('sealed', 'tainted', 'lapsed', 'clawed', 'expired', 'exercised',
                  'hardened', 'carve_out', 'merge_refused'));
CREATE INDEX seals_expiring_idx ON seals (expires_at)
  WHERE expires_at IS NOT NULL AND state IN ('sealed', 'tainted');

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · Cohorts — the measurement the product is for, and the one that could
--     become a weapon.
--
-- Medicare Advantage denied 7.4% of prior authorization requests in 2022.
-- Roughly 10% of those denials were appealed, and 83.2% of the appeals were
-- overturned (KFF analysis of CMS data, 2022). The ~90% who never appealed are
-- not a random draw. Without cohorts you can measure that errors exist; with
-- them you can measure WHOSE errors go uncorrected, which is the only question
-- those numbers actually raise.
--
-- A system where institutions tag people by attribute is a discrimination tool
-- wearing a fairness label. The constraints are therefore in the schema from
-- the first migration rather than in a policy document:
--
--   * Cohort membership is blinded, exactly like an alias.
--   * There is no per-subject cohort read anywhere in this codebase. Not
--     gated, not permissioned — not implemented, so there is nothing to abuse
--     and nothing to subpoena.
--   * Aggregates below a k-anonymity floor return null and say why, the same
--     discipline as the volume floor on every other measurement.
--   * A declared cohort type may not also be attested as a fact, so a cohort
--     cannot reach the grammar and cannot appear in a rule. Enforced in
--     `attest`, tested.
--
-- Cohorts exist to measure the system. Never to decide about a person.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE cohort_types (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cohort       TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, cohort),
  CONSTRAINT cohort_types_shape CHECK (cohort ~ '^[a-z][a-z0-9_]{0,30}$')
);

CREATE TABLE subject_cohorts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id   TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  cohort       TEXT NOT NULL,
  -- Blinded like an alias. Crimp can count members of a band without ever
  -- knowing which band, and cannot correlate across workspaces.
  band         TEXT NOT NULL CHECK (band ~ '^[0-9a-f]{32}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_id, cohort),
  FOREIGN KEY (workspace_id, cohort) REFERENCES cohort_types (workspace_id, cohort)
);
CREATE INDEX subject_cohorts_band_idx ON subject_cohorts (workspace_id, cohort, band);
