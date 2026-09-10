-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Two more axes on a claw rule: how MANY may reverse, and from WHERE.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 1 · Quorum — dual control on a reversal.
--
-- Four-eyes is standard practice for consequential irreversible acts in every
-- regulated industry, and reversing a standing determination about a person is
-- exactly one. It was inexpressible here: a claw needed one credential of
-- sufficient authority and nothing else could be asked for.
--
-- Two signatures from the SAME key is one signature typed twice, so the second
-- must come from a different key. Both must independently clear the authority,
-- the evidence floor and the cooling-off period — a quorum lowers no other bar.
--
-- The pending half expires. A dual-control decision that takes longer than a
-- week is not one decision made by two people, it is two unrelated decisions,
-- and leaving the first signature valid indefinitely means an attacker who
-- takes one key today and another next year still completes the quorum.
--
-- 2 · Jurisdiction — where the reversing human must be.
--
-- Authority in this system is a property of the credential and unforgeable by
-- the caller, so binding a credential to a jurisdiction makes "every reversal
-- affecting a person here was performed under authority bound here" a refusal
-- in code rather than a promise in a contract. An institution can offer it as
-- a provable claim; a procurement can require it.
--
-- A sealer may demand only the jurisdiction its OWN key is bound to. Allowing
-- an arbitrary string would hand back the denial-of-service the authority
-- ladder exists to prevent, on a third axis: demand a jurisdiction no key
-- holds and nobody can ever reverse.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE api_keys ADD COLUMN jurisdiction TEXT
  CHECK (jurisdiction IS NULL OR jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$');

ALTER TABLE seals ADD COLUMN claw_quorum SMALLINT NOT NULL DEFAULT 1
  CHECK (claw_quorum BETWEEN 1 AND 2);
ALTER TABLE seals ADD COLUMN claw_jurisdiction TEXT
  CHECK (claw_jurisdiction IS NULL OR claw_jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$');

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · A signature that is not yet a reversal — and the reason this is a table.
--
-- `claw_pending` is a new event kind, and adding one used to mean dropping the
-- CHECK constraint and re-adding it with the full list. Three migrations did
-- that, written on parallel branches, and each listed only the kinds it knew
-- about. Whichever ran last silently DELETED the others' kinds. Found by
-- integrating the branches and running the suite: four disclosure tests failed
-- with `violates check constraint "seal_events_kind_check"`, because this
-- migration — written on a branch that predates `disclosed` — removed it.
--
-- Each migration was correct against its own base. The combination was not,
-- and nothing about a green CI run on either branch could have shown it.
--
-- So the constraint becomes a reference table with a foreign key, which is
-- what `authority_levels` and `admissibility_classes` have always been.
-- Adding a kind is now an INSERT, and an INSERT cannot clobber. The seed
-- lists a superset deliberately — naming a kind no branch emits yet is
-- harmless, and absorbing whatever is already in the table means no branch's
-- history is lost whichever order these land in.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE seal_event_kinds (
  kind        TEXT PRIMARY KEY,
  description TEXT
);

INSERT INTO seal_event_kinds (kind, description) VALUES
  ('sealed',        'A determination was created'),
  ('tainted',       'The ground was lost — not a disproof'),
  ('lapsed',        'The premises withdrew their own support'),
  ('expired',       'It ran out. Not an error'),
  ('clawed',        'A person overruled it, on the record'),
  ('exercised',     'A permit was spent'),
  ('hardened',      'Reversal requirements rose under pressure'),
  ('carve_out',     'An alias was detached from a subject'),
  ('merge_refused', 'A merge was refused. The refusal is the signal'),
  ('claw_pending',  'One signature of a quorum, not yet a reversal'),
  ('disclosed',     'Somebody asked why a person was refused')
ON CONFLICT (kind) DO NOTHING;

-- Absorb anything already recorded, whatever branch introduced it.
INSERT INTO seal_event_kinds (kind)
  SELECT DISTINCT kind FROM seal_events ON CONFLICT (kind) DO NOTHING;

ALTER TABLE seal_events DROP CONSTRAINT seal_events_kind_check;
ALTER TABLE seal_events ADD CONSTRAINT seal_events_kind_fk
  FOREIGN KEY (kind) REFERENCES seal_event_kinds(kind);

-- Finding the standing half of a quorum is a hot lookup on the claw path.
CREATE INDEX seal_events_pending_idx ON seal_events (seal_id, occurred_at DESC)
  WHERE kind = 'claw_pending';
