-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- cap-09 · Drift and outage detection.
--
-- The question is "did this rule's rate of unknown, of no, of each refusal
-- reason, move beyond what the last fortnight would predict". Until now two
-- of those three outcomes left no trace: a rule that did not hold created
-- no seal, and a rule that could not be answered raised an error. A monitor
-- cannot count what was never written down.
--
-- So every evaluation is logged — outcome and reason code, per rule, per
-- workspace — and NOTHING ELSE. No subject, no facts, no values. A row here
-- says "this rule was tried at this moment and came out this way", which is
-- what a rate is made of and is not about anybody.

CREATE TABLE evaluation_log (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- `ruleset/rule_id` for a registered rule, else the first 16 hex of the hash.
  rule_key     TEXT NOT NULL,
  -- The brief's three values. `yes` sealed, `no` did not apply, `unknown`
  -- could not be answered.
  outcome      TEXT NOT NULL CHECK (outcome IN ('yes', 'no', 'unknown')),
  -- Why, for `unknown`: the machine-readable refusal code.
  reason       TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_log_rule_idx ON evaluation_log (workspace_id, rule_key, occurred_at DESC);
CREATE INDEX evaluation_log_recent_idx ON evaluation_log (workspace_id, occurred_at DESC);

INSERT INTO finding_classes (class, description) VALUES
  ('drift', 'A rule''s rate of an outcome or reason moved beyond its own recent baseline. Informational; never changes an outcome.')
ON CONFLICT (class) DO NOTHING;
