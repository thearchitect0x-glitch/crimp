-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Identity, sources, and attested facts.
--
-- THE ERASURE DECISION, MADE HERE BECAUSE IT CANNOT BE MADE LATER.
--
-- An append-only proof and a right to erasure are in direct conflict, and the
-- usual answer is crypto-shredding: store the content, then destroy the key.
-- This schema does something simpler and stronger — it never stores the
-- historical value in the first place.
--
--   * `attestations` holds the CURRENT value of a fact. It is mutable and it is
--     deletable, because it is operational state, not evidence.
--   * A seal records only `sha256(value)` as it stood at seal time. The raw
--     historical value is never written anywhere in this system.
--
-- So erasure is a DELETE, and it costs nothing that was load-bearing. The proof
-- still verifies: anyone holding the value can demonstrate it hashes to the
-- committed digest. The customer keeps its own records; Crimp keeps the
-- commitment. Reproducing a decision requires somebody to still have the facts,
-- which is correct — a decision nobody can produce the inputs for is a decision
-- nobody should be able to re-run.
--
-- Cost accepted: Crimp alone cannot re-evaluate a historical seal. It was never
-- entitled to.

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Admissibility: a partial order, not a ranking.
--
-- Two classes of evidence are frequently incomparable, and forcing them onto a
-- single scale invents a precision that is not there. A signed self-report and
-- an unsigned third-party observation are not orderable; neither dominates.
-- Stored as an explicit closure so "does this meet the floor" is one indexed
-- lookup rather than a graph walk on the hot path.
--
-- The floor rule that matters falls out of this table: an agent's own account
-- of events (`self`, `signed`) can never dominate `receipt` or `authority`, so
-- a claw rule requiring disinterested evidence cannot be satisfied by the party
-- the determination is against talking about itself.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE admissibility_classes (
  class        TEXT PRIMARY KEY,
  description  TEXT NOT NULL
);

INSERT INTO admissibility_classes (class, description) VALUES
  ('self',      'Unverified assertion by the acting agent. Proves nothing but intent.'),
  ('signed',    'Cryptographically signed by the acting agent. Non-repudiation, not truth.'),
  ('internal',  'The operator''s own system of record. Interested, but accountable.'),
  ('witness',   'A third party present to the event.'),
  ('receipt',   'A signed receipt from a disinterested party.'),
  ('authority', 'A government or regulated source of record.');

-- `higher` dominates `lower`. Reflexive rows included so a floor is satisfied
-- by its own class without a special case in the query.
CREATE TABLE admissibility_order (
  higher  TEXT NOT NULL REFERENCES admissibility_classes(class),
  lower   TEXT NOT NULL REFERENCES admissibility_classes(class),
  PRIMARY KEY (higher, lower)
);

INSERT INTO admissibility_order (higher, lower)
SELECT class, class FROM admissibility_classes;

INSERT INTO admissibility_order (higher, lower) VALUES
  ('signed',    'self'),
  ('internal',  'self'), ('internal',  'signed'),
  ('witness',   'self'), ('witness',   'signed'),
  ('receipt',   'self'), ('receipt',   'signed'), ('receipt',   'internal'), ('receipt', 'witness'),
  ('authority', 'self'), ('authority', 'signed'), ('authority', 'internal'),
  ('authority', 'witness'), ('authority', 'receipt');
-- Deliberately absent: internal vs witness. Neither dominates the other. An
-- operator's own ledger and an outside observer disagree in different
-- directions and a system that pretends to rank them is guessing.

-- ─────────────────────────────────────────────────────────────────────────
-- Fact sources.
--
-- Every attested fact names where it came from. This is the join that makes
-- the whole product's sharpest measurement possible: a source's reliability is
-- the rate at which determinations resting on it later lapsed. Nobody can
-- currently measure that about their own data vendors, because nobody records
-- which decision rested on which source.
--
-- It also defeats the specific mechanism synthetic identity fraud relies on.
-- Cultivation manufactures CONSENSUS — seed a fact, let institutions cite each
-- other until it looks corroborated. Consensus-based trust scoring rates that
-- identity highly, by construction. Outcome-grounded scoring cannot be gamed
-- the same way, because an outcome cannot be cultivated.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE fact_sources (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  admissibility TEXT NOT NULL REFERENCES admissibility_classes(class),
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source),
  CONSTRAINT fact_sources_name_shape CHECK (source ~ '^[a-z][a-z0-9_]{0,62}$')
);

-- ─────────────────────────────────────────────────────────────────────────
-- Subjects: who a determination is about, without Crimp ever seeing who.
--
-- Aliases are blinded exactly as Ratchet blinds a declared dimension:
-- HMAC(pepper, workspace|type|value), truncated to 128 bits. The workspace id
-- is inside the MAC, so the same account number in two workspaces produces two
-- unrelated identifiers and there is no cross-tenant correlation to leak.
--
-- Aliases merge into subjects and the merge is MONOTONE — it may only ever add
-- bindings. There is no unlink, by design: a determination you can dissolve
-- your way out of is not a determination. Mistaken merges are corrected by an
-- authority-signed carve-out against the determination, never by splitting the
-- graph. That correction machinery lands with the seal tables.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE subjects (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Degree bound: a subject that has absorbed too many components stops
  -- accepting merges. Real people do not have four hundred email addresses,
  -- and an unbounded merge is a denial-of-service that cannot be undone.
  alias_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX subjects_workspace_idx ON subjects (workspace_id);

CREATE TABLE subject_aliases (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alias_type    TEXT NOT NULL,
  -- 32 hex characters: 128 bits of a peppered MAC. The input is unrecoverable.
  blinded       TEXT NOT NULL,
  subject_id    TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  -- Whether this alias is strong enough to CAUSE a merge, as opposed to merely
  -- carrying a binding. A device id can inherit a refusal; it must not be able
  -- to drag two strangers into one subject.
  merge_strength TEXT NOT NULL CHECK (merge_strength IN ('strong', 'medium', 'weak')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, alias_type, blinded),
  CONSTRAINT subject_aliases_blinded_shape CHECK (blinded ~ '^[0-9a-f]{32}$'),
  CONSTRAINT subject_aliases_type_shape CHECK (alias_type ~ '^[a-z][a-z0-9_]{0,30}$')
);
CREATE INDEX subject_aliases_subject_idx ON subject_aliases (subject_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Attestations: the CURRENT value of a fact about a subject.
--
-- Operational state. Mutable, deletable, and never evidence. Evidence is the
-- hash a seal committed to; see the note at the top of this file.
--
-- Crimp never fetches these. The customer pushes them, which is what keeps the
-- product's central safety property intact: no vendor credentials, no outbound
-- access to customer systems. The cost is that the customer is the trust root
-- for its own facts, and an institution that attests falsely can produce a
-- valid proof of a wrong decision. That is documented as a permanent
-- limitation rather than patched over.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE attestations (
  workspace_id  TEXT NOT NULL,
  subject_id    TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  fact          TEXT NOT NULL,
  fact_type     TEXT NOT NULL CHECK (fact_type IN ('bool', 'int', 'str', 'time')),

  -- Exactly one of these is non-null, enforced below. Typed columns rather
  -- than a JSONB blob so the database can refuse a type confusion that the
  -- evaluator would otherwise have to catch at read time.
  bool_value    BOOLEAN,
  int_value     BIGINT,
  str_value     TEXT,

  source        TEXT NOT NULL,
  -- Denormalised from fact_sources so a seal's admissibility check is one row
  -- read, and so that later changing a source's class cannot retroactively
  -- alter what a past seal was entitled to rely on.
  admissibility TEXT NOT NULL REFERENCES admissibility_classes(class),

  asserted_at   TIMESTAMPTZ NOT NULL,
  -- Freshness is the caller's declaration, not our inference. A rule that
  -- reads a stale fact is a decision the operator chose to make.
  expires_at    TIMESTAMPTZ,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, subject_id, fact),
  FOREIGN KEY (workspace_id, source) REFERENCES fact_sources (workspace_id, source),
  CONSTRAINT attestations_fact_shape
    CHECK (fact ~ '^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$'),
  CONSTRAINT attestations_one_typed_value CHECK (
    (fact_type = 'bool' AND bool_value IS NOT NULL AND int_value IS NULL AND str_value IS NULL) OR
    (fact_type = 'int'  AND int_value  IS NOT NULL AND bool_value IS NULL AND str_value IS NULL) OR
    (fact_type = 'time' AND int_value  IS NOT NULL AND bool_value IS NULL AND str_value IS NULL) OR
    (fact_type = 'str'  AND str_value  IS NOT NULL AND bool_value IS NULL AND int_value IS NULL)
  )
);
CREATE INDEX attestations_subject_idx ON attestations (workspace_id, subject_id);
-- Source scoring reads by source across a workspace; keep it off a seq scan.
CREATE INDEX attestations_source_idx ON attestations (workspace_id, source);
