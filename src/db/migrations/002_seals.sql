-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos.MX
--
-- Seals: the determination itself, and everything that can happen to one.
--
-- THE LIFECYCLE FALLS OUT OF THE THIRD TRUTH VALUE.
--
-- A seal is created when its rule evaluates TRUE. Re-evaluating that same rule
-- later against current attestations gives the whole lifecycle for free:
--
--   still TRUE   → the seal stands.
--   now  FALSE   → LAPSED. Reality withdrew its own support. No authority was
--                  involved, nobody won an argument, and nothing was persuaded.
--   now  UNKNOWN → TAINTED. The ground is gone but the claim is not disproved.
--                  Still binding, surfaced for review, never auto-lifted.
--
-- That last line is Ratchet's `indeterminate` doctrine, unchanged: a known
-- unknown is surfaced rather than guessed. It is also why `tainted` is not a
-- bolted-on flag — there was a third value and it already meant this.
--
-- CLAW is the fourth outcome and the only one involving a person. It is
-- deliberately awkward, and it never deletes.

CREATE TABLE authority_levels (
  level  TEXT PRIMARY KEY,
  rank   INTEGER NOT NULL UNIQUE,
  note   TEXT NOT NULL
);

-- Unlike admissibility, authority IS a total order. Admissibility describes
-- kinds of evidence, which are frequently incomparable; authority describes
-- who may overrule whom, which is hierarchical by construction. Pretending
-- otherwise would leave "who wins" undefined at exactly the moment it matters.
INSERT INTO authority_levels (level, rank, note) VALUES
  ('agent',     0, 'An autonomous agent. May seal. May never lift what it sealed.'),
  ('operator',  1, 'A human running the workspace. Ordinary cleanup authority.'),
  ('principal', 2, 'The accountable owner of the business decision.'),
  ('custodian', 3, 'Escrowed authority of last resort. Deliberately inconvenient.');

CREATE TABLE seals (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id     TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,

  -- What this constrains. Dotted, hierarchical: a seal on `refund` covers
  -- `refund.issue.goodwill`. See src/domain/scope.ts for the containment rule
  -- and for what v1 deliberately does not model.
  scope          TEXT NOT NULL,

  disposition    TEXT NOT NULL CHECK (disposition IN ('bind', 'permit', 'commit')),

  -- The rule AS WRITTEN. Never normalised, never rewritten — an examiner is
  -- shown what the agent authored, not what we tidied it into.
  rule           JSONB NOT NULL,
  -- sha256 of the CANONICAL form, in which commutative children are sorted.
  -- Two agents expressing the same policy in different orders share this hash,
  -- which is what later makes "were like cases treated alike" answerable.
  rule_hash      TEXT NOT NULL CHECK (rule_hash ~ '^[0-9a-f]{64}$'),

  state          TEXT NOT NULL DEFAULT 'sealed'
                   CHECK (state IN ('sealed', 'tainted', 'lapsed', 'clawed')),

  sealed_by      TEXT NOT NULL REFERENCES authority_levels(level),

  -- The claw rule, fixed at seal time. Invariant II: it may be tightened later
  -- and never loosened, so a sealer chooses its own jailer before it knows
  -- whether it will want one.
  claw_authority     TEXT NOT NULL REFERENCES authority_levels(level),
  claw_evidence_floor TEXT NOT NULL REFERENCES admissibility_classes(class),
  claw_cooling_off_s  INTEGER NOT NULL DEFAULT 0 CHECK (claw_cooling_off_s >= 0),

  -- `permit` only. A grant that may be spent a bounded number of times; the
  -- caller after that gets `already_exercised`.
  max_uses       INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses           INTEGER NOT NULL DEFAULT 0,

  sealed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at     TIMESTAMPTZ,

  -- Invariant III, in the schema rather than only in code: the authority that
  -- may reverse must strictly exceed the authority that sealed. An agent can
  -- seal a refusal it can never lift, which is the sentence the product is
  -- sold on.
  CONSTRAINT seals_no_self_reversal CHECK (claw_authority <> sealed_by),
  CONSTRAINT seals_uses_bounded CHECK (max_uses IS NULL OR uses <= max_uses),
  CONSTRAINT seals_permit_only_uses CHECK (disposition = 'permit' OR max_uses IS NULL)
);

-- The hot path: "is this subject bound in this scope?" One partial index scan.
CREATE INDEX seals_binding_idx ON seals (workspace_id, subject_id, scope)
  WHERE state IN ('sealed', 'tainted');
-- Re-evaluation sweeps walk live seals oldest-first.
CREATE INDEX seals_live_idx ON seals (workspace_id, sealed_at)
  WHERE state IN ('sealed', 'tainted');
CREATE INDEX seals_rule_hash_idx ON seals (workspace_id, rule_hash);

-- ─────────────────────────────────────────────────────────────────────────
-- What the seal rested on.
--
-- This table is the product's sharpest measurement. A source's reliability is
-- the rate at which determinations relying on it later lapsed — a number no
-- institution currently has about its own data vendors, because nobody records
-- which decision rested on which source.
--
-- `value_sha256` is the commitment. The raw historical value is never stored
-- anywhere in this system; see the note atop 001. Erasure of the current
-- attestation leaves this row intact and the proof still verifies for anyone
-- who holds the value.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE seal_facts (
  seal_id        TEXT NOT NULL REFERENCES seals(id) ON DELETE CASCADE,
  fact           TEXT NOT NULL,
  fact_type      TEXT NOT NULL,
  value_sha256   TEXT NOT NULL CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
  source         TEXT NOT NULL,
  admissibility  TEXT NOT NULL REFERENCES admissibility_classes(class),
  asserted_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (seal_id, fact)
);
CREATE INDEX seal_facts_source_idx ON seal_facts (source);

-- ─────────────────────────────────────────────────────────────────────────
-- Append-only history. Nothing here is ever updated or deleted.
--
-- Invariant VII: clawing does not remove a seal, it records a reversal. For a
-- regulated buyer the record of the reversal — who, when, on what evidence,
-- after what elapsed delay — is the artifact the examiner actually asks for.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE seal_events (
  id           BIGSERIAL PRIMARY KEY,
  seal_id      TEXT NOT NULL REFERENCES seals(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('sealed', 'tainted', 'lapsed', 'clawed', 'exercised',
                  'hardened', 'carve_out', 'merge_refused')),
  -- Who acted, where a person did. NULL for lapse: nothing decided a lapse.
  actor        TEXT REFERENCES authority_levels(level),
  -- Evidence supporting a claw, by commitment only.
  evidence_sha256 TEXT CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_class  TEXT REFERENCES admissibility_classes(class),
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX seal_events_seal_idx ON seal_events (seal_id, occurred_at);
CREATE INDEX seal_events_workspace_kind_idx ON seal_events (workspace_id, kind, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Pressure: refused attempts to act against a standing determination.
--
-- The observable nothing else can have. A merchant's database records the
-- refund that happened; logs keep successes; an agent's context holds one turn.
-- Nothing anywhere records how many times somebody tried to get past a decision
-- and was stopped.
--
-- Counted in a rolling window, because months-old pressure is history rather
-- than signal — the same reasoning that makes a daily ceiling rolling.
--
-- `session` is caller-supplied and blinded. A caller that lies about it only
-- misleads itself: these are the institution's own agents, and the count exists
-- for the institution's own benefit. Recorded as a claim, not a fact.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE pressure (
  seal_id      TEXT NOT NULL REFERENCES seals(id) ON DELETE CASCADE,
  session      TEXT NOT NULL CHECK (session ~ '^[0-9a-f]{32}$'),
  attempts     INTEGER NOT NULL DEFAULT 0,
  first_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seal_id, session)
);
CREATE INDEX pressure_recent_idx ON pressure (seal_id, last_at DESC);
