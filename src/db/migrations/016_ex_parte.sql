-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- cap-07 · Cross-programme reconciliation, as the law states it: ex parte first.
--
-- 42 CFR 435.916(b)(1): before asking a person for anything, the agency must
-- try to renew from the information it already holds — from any programme.
-- A procedural termination ("they did not return the form") is therefore not
-- available when the merits could have been decided from facts on file.
--
-- The fact store is already shared across programmes: a subject's facts have
-- no programme, and a rule reads whatever is attested. What was missing is
-- the ORDER: substantive before procedural. A ruleset may now name the rule
-- that IS its ex parte determination; a procedural rule under that ruleset
-- may not seal while the named rule is decidable from the facts on file.
--
-- Which programme a fact came from lives on its SOURCE, where it belongs:
-- the institution declared the source, and it knows whose system it is.

ALTER TABLE rulesets ADD COLUMN ex_parte_rule TEXT
  CHECK (ex_parte_rule IS NULL OR ex_parte_rule ~ '^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$');

ALTER TABLE fact_sources ADD COLUMN programme TEXT
  CHECK (programme IS NULL OR programme ~ '^[a-z][a-z0-9_]{0,30}$');
