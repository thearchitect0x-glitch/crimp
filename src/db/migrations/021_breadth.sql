-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Breadth: one declared session refused across many distinct
-- determinations within the pressure window. A finding about the session
-- — an opaque, caller-declared identifier, not a person — kept apart from
-- the per-determination pressure that hardens, so that an enumerator's
-- breadth never raises the bar against the people it touched.
INSERT INTO finding_classes (class, description) VALUES
  ('probing_breadth', 'One declared session was refused across many distinct determinations within the pressure window: an enumeration signature, about the session and not about any person')
ON CONFLICT (class) DO NOTHING;

ALTER TABLE findings DROP CONSTRAINT findings_subject_kind_check;
ALTER TABLE findings ADD CONSTRAINT findings_subject_kind_check
  CHECK (subject_kind IN ('clock', 'seal', 'rule', 'workspace', 'session'));

-- One breadth finding per session per day, by index rather than by logic.
CREATE UNIQUE INDEX findings_one_breadth_per_session_day_idx
  ON findings (workspace_id, subject_id, (detail->>'day'))
  WHERE class = 'probing_breadth';

CREATE INDEX pressure_session_idx ON pressure (session, last_at DESC) WHERE declared;
