-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- cap-01 · A fact catalogue, and delivery as a precondition to non-response.
--
-- The brief asks that a rule about "failure to respond" be unable to decide
-- anything until delivery of the notice is attested. The obvious way is to
-- look for words like "respond" in fact names and demand a delivery fact
-- beside them. That is a denylist, and a denylist of names is beaten by the
-- next name — `renewal_packet_recv` — which is exactly the bypass the brief's
-- test (d) asks us to refuse.
--
-- So the enforcement is structural rather than lexical, in two parts.
--
-- THE CATALOGUE. A workspace may declare its facts: name, type, class. Once it
-- has declared any, the set is closed: a rule may name only catalogued facts
-- and an attestation may assert only catalogued facts. A synonym is then not
-- detected, it is impossible — a fact the programme never defined cannot be
-- named, and defining one is an operator's act, on the record. A workspace
-- that declares nothing behaves exactly as before.
--
-- THE GUARD. A fact of class `non_response` MUST name a `delivery` fact that
-- guards it (enforced below). When a rule is evaluated, a guarded fact is
-- withheld from the evaluator unless its guard holds — so "did not return the
-- renewal" is UNKNOWN, not FALSE, until "the renewal reached them" is TRUE.
-- The evaluator does not change. It receives fewer facts, and three-valued
-- logic does the rest.
--
-- Nothing here reaches the record format. Strong Kleene evaluation is
-- monotone in information: a determination that sealed TRUE with a fact
-- withheld is TRUE under every value of that fact, so an examiner who holds
-- the value reproduces the outcome.

CREATE TABLE fact_catalogue (
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fact           TEXT NOT NULL,
  fact_type      TEXT NOT NULL CHECK (fact_type IN ('bool', 'int', 'str', 'time')),
  class          TEXT NOT NULL CHECK (class IN ('plain', 'non_response', 'delivery')),
  -- For `non_response`: the delivery fact that must hold first, and the value
  -- it must hold. For everything else, null.
  guarded_by     TEXT,
  guard_value    TEXT,
  -- For `str` facts, the closed set of values an attestation may carry. A
  -- `delivery` fact is fixed to delivered / returned / unknown by the domain.
  allowed_values TEXT[],
  description    TEXT,
  declared_by    TEXT NOT NULL REFERENCES authority_levels(level),
  declared_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, fact),
  CONSTRAINT fact_catalogue_shape
    CHECK (fact ~ '^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$'),
  -- The invariant this table exists for: a non-response fact without a guard
  -- cannot be written, and a guard cannot be attached to anything else.
  CONSTRAINT fact_catalogue_guard_iff_non_response
    CHECK ((class = 'non_response') = (guarded_by IS NOT NULL)),
  CONSTRAINT fact_catalogue_guard_has_value
    CHECK ((guarded_by IS NULL) = (guard_value IS NULL)),
  CONSTRAINT fact_catalogue_guard_not_self CHECK (guarded_by IS NULL OR guarded_by <> fact),
  CONSTRAINT fact_catalogue_allowed_only_str
    CHECK (allowed_values IS NULL OR fact_type = 'str'),
  -- The guard must itself be catalogued. That it must be of class `delivery`
  -- is enforced in the domain, where the message can say so.
  FOREIGN KEY (workspace_id, guarded_by) REFERENCES fact_catalogue (workspace_id, fact)
);

-- Who asserted it: the credential, as the issuer identifies it. Property 1 of
-- the brief — "each with source, attester, timestamp" — and the ground
-- capability 10 stands on. Null for every row that predates this migration.
ALTER TABLE attestations ADD COLUMN attester TEXT;
ALTER TABLE seal_facts ADD COLUMN attester TEXT;
