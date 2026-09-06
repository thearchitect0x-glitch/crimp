-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Declared alias types.
--
-- `blindAliases` already refuses an undeclared alias type rather than guessing
-- its merge strength: guessing "weak" makes an identifier useless, guessing
-- "strong" makes it a weapon that unions strangers. Until now the declaration
-- lived in a constant the tests passed in. This is where it actually belongs.
--
-- Strength is not cosmetic. Only a strong alias may CAUSE a merge; a weak one
-- may carry a binding it inherits but may never create one. A device id or an
-- IP is shared by construction, and merging on one unions people who have
-- never met — permanently, because merges are monotone.

CREATE TABLE alias_types (
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alias_type     TEXT NOT NULL,
  merge_strength TEXT NOT NULL CHECK (merge_strength IN ('strong', 'medium', 'weak')),
  description    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, alias_type),
  CONSTRAINT alias_types_shape CHECK (alias_type ~ '^[a-z][a-z0-9_]{0,30}$')
);
