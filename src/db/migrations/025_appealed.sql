-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- An appeal, on the record of the determination it contests. Found by the
-- prior-authorization configuration: resistance there arrives as an
-- appeal, not as a person coming back to be refused again, and the
-- quadrant was blind to it. An event, never a state change; the ruling,
-- when it comes, is the adjudication family.
INSERT INTO seal_event_kinds (kind, description) VALUES
  ('appealed', 'An appeal, reconsideration, grievance or external review was filed against this determination')
ON CONFLICT (kind) DO NOTHING;

-- The quadrant asks, per determination, whether an appeal exists.
CREATE INDEX seal_events_appealed_idx ON seal_events (seal_id) WHERE kind = 'appealed';
