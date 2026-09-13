-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- A signature proves who issued a record. It does not prove WHEN, and in
-- 2038 a verifier may not trust a 2026 key at all. So every sealed core's
-- digest is kept, and once a day the pass folds the day's digests into a
-- Merkle root per workspace (RFC 6962 construction), and the workspace
-- roots into one global root. The global root is published without
-- authentication and can be anchored to a public timestamp; a record then
-- carries an inclusion path from its own core to a value the world saw on
-- a date, independent of every key the issuer holds.
ALTER TABLE seals ADD COLUMN core_sha256 TEXT CHECK (core_sha256 IS NULL OR core_sha256 ~ '^[0-9a-f]{64}$');
CREATE INDEX seals_core_day_idx ON seals (workspace_id, (timezone('UTC', sealed_at)::date), sealed_at, id)
  WHERE core_sha256 IS NOT NULL;

CREATE TABLE transparency_roots (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  root          TEXT NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  leaf_count    INTEGER NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day)
);

-- One root per day over every workspace's root, in workspace-id order.
CREATE TABLE transparency_global_roots (
  day           DATE PRIMARY KEY,
  root          TEXT NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  workspaces    INTEGER NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Whatever anchored it, if anything: e.g. an OpenTimestamps proof, base64,
  -- with the calendar that took it. Null until an operator or the pass
  -- anchors it. The root is the same either way; the anchor is what a
  -- stranger checks it against.
  anchor        JSONB
);
