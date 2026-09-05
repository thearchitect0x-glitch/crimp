-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
--
-- Remove the in-band sentinel from pressure.
--
-- An attempt with no declared session was bucketed under an all-zero session
-- id, and the distinct-session count excluded that value. Two problems, one
-- real: a caller that legitimately supplied 32 zeros had its session silently
-- dropped from the count, and the count is what promotes a seal from
-- `persistent` to `probing`. A sentinel that lives in the same value space as
-- real data is a sentinel that eventually collides with real data.
--
-- Out of band instead. Nothing a caller can send can now be mistaken for the
-- absence of a session.

ALTER TABLE pressure ADD COLUMN declared BOOLEAN NOT NULL DEFAULT true;

-- Existing sentinel rows, if any, are undeclared by definition.
UPDATE pressure SET declared = false WHERE session = repeat('0', 32);

COMMENT ON COLUMN pressure.declared IS
  'Whether the caller identified a session. Undeclared attempts still count '
  'toward `attempts` but contribute nothing to the distinct-session count, '
  'because an unidentified caller is not evidence of a second caller.';
