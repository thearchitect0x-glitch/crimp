-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- What a declared session did, per day: how often it asked, how often about
-- somebody the system does not know, how often it was refused. Breadth reads
-- it to tell a queue from an enumeration. No subject is named; a session is
-- an opaque, caller-declared identifier. Pruned with the pressure rows.
CREATE TABLE session_activity (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session           TEXT NOT NULL CHECK (session ~ '^[0-9a-f]{32}$'),
  day               DATE NOT NULL,
  lookups           INTEGER NOT NULL DEFAULT 0,
  unknown_subjects  INTEGER NOT NULL DEFAULT 0,
  refusals          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, session, day)
);
