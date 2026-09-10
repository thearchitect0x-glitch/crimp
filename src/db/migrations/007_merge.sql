-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Subject merge, and the carve-out that is its only correction.
--
-- Until now Crimp refused with `merge_required` when presented aliases already
-- belonged to several subjects, and the error told the caller to "resolve the
-- merge" — through an endpoint that did not exist. Three pieces of scaffolding
-- were already in the tree for it: MAX_SUBJECTS_PER_MERGE, mergeCapable(), and
-- the `carve_out` / `merge_refused` event kinds in migration 002. None of them
-- were reachable.
--
-- That was worse than a missing feature. `check` is the hot path — the call
-- that sits in front of every agent action — and it threw a 409 with no action
-- a caller could take. A gate that cannot answer is not failing closed, it is
-- failing silent, and the agent's only options were to proceed unsafely or to
-- stop serving that person permanently.
--
-- WHY THIS IS DANGEROUS, WHICH IS WHY IT IS BOUNDED IN THE SCHEMA.
--
-- A merge is monotone: it may only ever add bindings. That closes the obvious
-- evasion — a fresh email still presenting a known card is dragged under the
-- existing determination — and opens a worse one. If a merge can never be
-- undone, a POISONING MERGE is a denial of service that cannot be reversed:
-- present your own identifier alongside a widely-shared one, force the union,
-- and drag strangers under somebody else's refusal.
--
-- Four defences, three of which were already named in `src/lib/blind.ts`:
--
--   1. Only merge-capable (strong) aliases may cause a union, and EVERY
--      subject drawn into one must be reached by one. A device id can inherit
--      a refusal; it must never unify two strangers.
--   2. A degree bound. At most MAX_SUBJECTS_PER_MERGE subjects in one merge,
--      and a union may not exceed MAX_ALIASES_PER_SUBJECT components. Real
--      people do not have four hundred email addresses.
--   3. Authority and evidence. A merge is a `principal` act carrying a digest
--      whose class dominates `internal`, so an agent's own word — `self` or
--      `signed` — can never union two people.
--   4. A carve-out, the only correction. It cannot un-merge; nothing can. It
--      detaches one alias from one subject and records that it may never
--      re-attach.
--
-- A refused merge is recorded, not merely rejected. The refusal is the signal.

-- ─────────────────────────────────────────────────────────────────────────
-- History that outlives its subject.
--
-- Deliberately NO foreign key on subject_id. A merge deletes the absorbed
-- subjects, and the record of the merge is precisely the thing that must
-- survive that. `seal_events` cascades because seals are never deleted;
-- subjects are.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE subject_events (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The surviving subject, or NULL for a merge that was refused before a
  -- winner was chosen.
  subject_id      TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('merged', 'merge_refused', 'carve_out')),
  actor           TEXT NOT NULL REFERENCES authority_levels(level),
  evidence_sha256 TEXT CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_class  TEXT REFERENCES admissibility_classes(class),
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subject_events_subject_idx ON subject_events (subject_id, occurred_at);
CREATE INDEX subject_events_workspace_kind_idx
  ON subject_events (workspace_id, kind, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- The correction.
--
-- A carve-out does not undo a merge — a monotone union cannot be undone, and
-- claiming otherwise would be a lie the rest of the design depends on not
-- telling. It detaches one alias from one subject and makes that permanent, so
-- the alias resolves somewhere else from now on.
--
-- The row must outlive the detach, because its whole job is to stop the next
-- attestation quietly re-attaching the same alias to the same subject.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE alias_carve_outs (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alias_type      TEXT NOT NULL,
  blinded         TEXT NOT NULL,
  -- The subject this alias may never re-attach to. No foreign key, for the
  -- same reason as above: the subject may later be absorbed by a merge.
  subject_id      TEXT NOT NULL,
  actor           TEXT NOT NULL REFERENCES authority_levels(level),
  evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_class  TEXT NOT NULL REFERENCES admissibility_classes(class),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, alias_type, blinded, subject_id),
  CONSTRAINT alias_carve_outs_blinded_shape CHECK (blinded ~ '^[0-9a-f]{32}$')
);
CREATE INDEX alias_carve_outs_subject_idx ON alias_carve_outs (subject_id);

-- ─────────────────────────────────────────────────────────────────────────
-- The threshold a comment already promised.
--
-- `src/lib/blind.ts` says a `medium` alias "may cause a merge only when the
-- workspace lowers the threshold". There was no threshold, so it could not.
-- `strong` is the default and the safe answer: an identifier bound to one
-- person by an issuing authority or a payment network. A workspace whose
-- emails really are one-per-person may lower it and accept what that means.
--
-- `weak` is deliberately not an accepted value. A workspace may not configure
-- its way into unioning strangers by device id.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE workspaces ADD COLUMN merge_threshold TEXT NOT NULL DEFAULT 'strong'
  CHECK (merge_threshold IN ('strong', 'medium'));
