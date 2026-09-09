-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- cap-03 · Clocks, and the findings they produce.
--
-- A clock is what a programme owes a person: a determination within 45 days
-- of the application, expedited SNAP within 7, a hearing decided within 90.
-- It starts from an ATTESTED event (the application was received on this
-- date — a claim by a named source, like every other fact here), it is met by
-- something on the record (a seal in scope, or an attestation of a named
-- fact), and if the due date passes first it is missed.
--
-- A missed clock produces a FINDING. A finding is addressed to the agency,
-- never to the person: nothing in the seal path or the evaluator reads this
-- table, so a finding cannot change an outcome. That is not a convention, it
-- is the absence of any code path.
--
-- Findings are the cross-cutting table three capabilities share (3, 6, 9).
-- Classes are a reference table, like seal_event_kinds, for the same reason:
-- a CHECK constraint is clobbered by the next migration that forgets it.

CREATE TABLE finding_classes (
  class       TEXT PRIMARY KEY,
  description TEXT NOT NULL
);
INSERT INTO finding_classes (class, description) VALUES
  ('agency_timeliness', 'A clock the agency owed the person was missed. Never changes an outcome.')
ON CONFLICT (class) DO NOTHING;

CREATE TABLE findings (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  class           TEXT NOT NULL REFERENCES finding_classes(class),
  -- What the finding is about. A clock, a determination, a rule, or the
  -- workspace as a whole. Not a person: a finding never carries a subject.
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('clock', 'seal', 'rule', 'workspace')),
  subject_id      TEXT NOT NULL,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX findings_class_idx ON findings (workspace_id, class, occurred_at DESC);
-- One timeliness finding per clock, whatever the sweep does. Idempotency by
-- index, not by application logic that two workers could both get past.
CREATE UNIQUE INDEX findings_one_per_clock_idx ON findings (workspace_id, subject_kind, subject_id)
  WHERE class = 'agency_timeliness';

CREATE TABLE clocks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id   TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  -- One of the names in clocks.config.ts. Not a foreign key, because the
  -- definitions are code with legal citations, not rows.
  name         TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  due_at       TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'met', 'missed')),
  -- When it was met on time; when it was found missed; and, for a missed
  -- clock, when the owed thing finally happened — lateness is a number.
  met_at       TIMESTAMPTZ,
  missed_at    TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ,
  -- The determination that met or resolved it, if a seal did.
  seal_id      TEXT REFERENCES seals(id) ON DELETE SET NULL,
  started_by   TEXT NOT NULL REFERENCES authority_levels(level),
  started_key  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT clocks_window CHECK (due_at > started_at),
  CONSTRAINT clocks_scope_shape CHECK (scope = '*' OR scope ~ '^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$')
);
-- The sweep's query: what is running, oldest due first.
CREATE INDEX clocks_running_idx ON clocks (workspace_id, due_at) WHERE status = 'running';
-- One running clock of a name per subject and scope. Starting it twice is a
-- replay, not a second clock.
CREATE UNIQUE INDEX clocks_one_running_idx ON clocks (workspace_id, subject_id, scope, name)
  WHERE status = 'running';
CREATE INDEX clocks_subject_idx ON clocks (workspace_id, subject_id);
