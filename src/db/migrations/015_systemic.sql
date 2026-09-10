-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- cap-06 · Systemic-error propagation.
--
-- A fair hearing reverses one person's refusal and says WHY: the rule the
-- agency applied misreads the law, or a fact it rested on may not be used
-- that way. That ruling is about one appellant, but the rule was applied to
-- everybody. The ruling is attested about the appellant as facts —
-- `adjudication.ruling`, `.ruleset`, `.rule_id`, `.pattern`, `.authority`,
-- `.date` — by the hearing authority as a named source, like every other
-- fact. The sweep then finds every open determination made under the same
-- rule (by registered id, or by identical content), flags it, marks it due,
-- records the review on each, and raises ONE finding naming them all.
--
-- What it does NOT do: change any outcome. A ruling that a rule is wrong
-- does not, by itself, tell the evaluator what the right rule is; that is
-- the operator's act (close the version, commit a successor — cap-08) and
-- the caseworker's (re-determine — cap-10). The flag makes the review
-- visible on every lookup, proof and notice until the determination moves.

INSERT INTO finding_classes (class, description) VALUES
  ('systemic_review', 'A ruling against one determination reaches every other made under the same rule. Never changes an outcome.')
ON CONFLICT (class) DO NOTHING;

INSERT INTO seal_event_kinds (kind, description) VALUES
  ('systemic_review', 'A ruling elsewhere put this determination under review')
ON CONFLICT (kind) DO NOTHING;

-- When this determination was placed under systemic review, if ever. Never
-- cleared: a determination that moves (lapses, is clawed, expires) leaves
-- the flag as history; one that stands shows it on every read.
ALTER TABLE seals ADD COLUMN review_flagged_at TIMESTAMPTZ;

-- One review per ruling. The ruling is identified by the appellant and the
-- moment it was attested; a re-attested ruling is a new ruling.
CREATE TABLE systemic_reviews (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  appellant_subject_id   TEXT NOT NULL,
  ruling_asserted_at     TIMESTAMPTZ NOT NULL,
  ruleset                TEXT NOT NULL,
  rule_id                TEXT NOT NULL,
  pattern                TEXT,
  affected_count         INTEGER NOT NULL,
  finding_id             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, appellant_subject_id, ruling_asserted_at)
);
