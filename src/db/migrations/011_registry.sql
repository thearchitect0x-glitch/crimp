-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- cap-08 · A rule registry: ids, versions, legal citations, effective windows.
--
-- Until now every rule arrived inline with the seal that used it. That is the
-- product's thesis — the agent submits the rule it is applying — and it stays.
-- What it could not do is answer three questions a regulated buyer asks:
--
--   which law is this rule implementing?         (legal_authority)
--   which version was in force on that date?     (effective_from / effective_to)
--   every determination made under this rule?    (rule_id, not just rule_hash)
--
-- Four other capabilities rest on those answers, which is why this lands first.
--
-- DESIGN DECISIONS, RESOLVED FROM THE CODE RATHER THAN GUESSED.
--
-- Version IS the rule hash. A registered rule is immutable by construction:
-- you cannot edit a hash, you can only commit a successor with a new effective
-- window. Two workspaces that commit the same policy text get the same version,
-- so "how often does this policy shape lapse" becomes computable across tenants
-- without sharing a single fact about a person.
--
-- Effective windows are enforced by the database, not the application. The
-- exclusion constraint below means two versions of one rule can never be in
-- force at the same instant, so "which version governed on date D" has exactly
-- one answer — the steel jamb, not the door.
--
-- The seal keeps its rule INLINE, exactly as before. `rule_ref` is a snapshot
-- beside it, never a pointer instead of it. A proof must verify in 2032 without
-- this table existing; the reference is for finding, citing and grouping.
--
-- A ruleset is not a scope. A scope is what a determination constrains; a
-- ruleset is a named collection of rules a programme has committed to. A rule
-- may carry a scope of its own, and a seal made under it must sit inside that.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE rulesets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ruleset      TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, ruleset),
  CONSTRAINT rulesets_name_shape CHECK (ruleset ~ '^[a-z][a-z0-9_]{0,30}$')
);

CREATE TABLE rules (
  workspace_id    TEXT NOT NULL,
  ruleset         TEXT NOT NULL,
  -- A stable human name across versions, e.g. `renewal.income_test`.
  rule_id         TEXT NOT NULL,
  -- The canonical-form hash. Identity of the CONTENT; two identical policies
  -- have one version wherever they were committed.
  version         TEXT NOT NULL CHECK (version ~ '^[0-9a-f]{64}$'),
  rule            JSONB NOT NULL,
  grammar_version TEXT NOT NULL,
  -- The provision this rule implements. Validated for shape in the domain
  -- layer; stored as written so an examiner sees what the committer wrote.
  legal_authority TEXT NOT NULL CHECK (length(legal_authority) BETWEEN 1 AND 200),
  -- Optional. When set, a seal made under this rule must sit inside it.
  scope           TEXT,
  effective_from  TIMESTAMPTZ NOT NULL,
  effective_to    TIMESTAMPTZ,
  committed_by    TEXT NOT NULL REFERENCES authority_levels(level),
  committed_key   TEXT NOT NULL,
  committed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The one thing about a committed version that may change afterwards: an
  -- open-ended window is closed when the law changes. Who did it, and when,
  -- because a window that moved with nobody's name on it is a window that
  -- can be moved to un-govern a decision.
  closed_by       TEXT REFERENCES authority_levels(level),
  closed_at       TIMESTAMPTZ,
  note            TEXT,
  PRIMARY KEY (workspace_id, ruleset, rule_id, version),
  FOREIGN KEY (workspace_id, ruleset) REFERENCES rulesets (workspace_id, ruleset) ON DELETE CASCADE,
  CONSTRAINT rules_id_shape CHECK (rule_id ~ '^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$'),
  CONSTRAINT rules_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- One rule id, one version in force at any instant. `&&` is range overlap;
  -- a NULL effective_to is an open-ended range. This is what makes as-of
  -- selection a lookup with exactly one answer rather than a policy question.
  CONSTRAINT rules_one_in_force EXCLUDE USING gist (
    workspace_id WITH =,
    ruleset      WITH =,
    rule_id      WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);
-- "Which version governed on date D" and "every version of this rule".
CREATE INDEX rules_in_force_idx ON rules USING gist (
  workspace_id, ruleset, rule_id, tstzrange(effective_from, effective_to, '[)'));
-- "Every rule implementing this provision", across rulesets.
CREATE INDEX rules_authority_idx ON rules (workspace_id, legal_authority);

-- The seal's snapshot of which registered rule it was made under. NULL for an
-- inline rule, and for every seal that predates this migration. Denormalised
-- on purpose: the record must be complete without a join. The rule CONTENT in
-- the registry is immutable, so `version` can never disagree; the window is
-- recorded AS IT WAS when sealed, which is itself evidence — a seal made while
-- a version was believed open-ended says so, whatever was later decided.
ALTER TABLE seals ADD COLUMN rule_ref JSONB;
-- The date the decision is ABOUT, which is not always the date it was made —
-- retroactive eligibility looks back three months. Registry selection uses
-- this. The evaluator never sees it; time enters evaluation only as an
-- attested fact. NULL means "as of sealed_at", which is every existing row.
ALTER TABLE seals ADD COLUMN as_of TIMESTAMPTZ;

-- "Every open determination made under this rule id" — capability 6's query.
CREATE INDEX seals_rule_ref_idx ON seals (workspace_id, (rule_ref->>'ruleset'), (rule_ref->>'rule_id'))
  WHERE rule_ref IS NOT NULL AND state IN ('sealed', 'tainted');
