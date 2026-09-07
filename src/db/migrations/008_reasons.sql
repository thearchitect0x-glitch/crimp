-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Why, on the record — and who asked.
--
-- A determination that cannot say why is not usable by the buyers this product
-- is for. ECOA/Regulation B requires the specific principal reasons for an
-- adverse action; CFPB Circular 2022-03 says a complex algorithm does not
-- excuse a creditor from giving them, and Circular 2023-03 says they must be
-- accurate and specific rather than a grab bag. CMS-0057-F requires a specific
-- denial reason on prior authorization. Crimp holds the rule that was applied,
-- so it is the only party that can derive the reason mechanically instead of
-- reconstructing it afterwards from something that was never written down.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 1 · The reasons are stored, and they carry no values.
--
-- Every reason is a projection of the rule: a path, a fact name, an operator,
-- a literal. All of it is already inside `rule`, so storing it adds no
-- information about the person and keeps the erasure story intact — a fact's
-- historical VALUE is still nowhere in this database.
--
-- It cannot be re-derived later, which is why it is stored. Knowing which
-- branch of an `any` fired requires the facts as they were, and those are held
-- only as digests. The reason set is the record of what was decided at the
-- moment it was decided; re-evaluating tomorrow answers a different question.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE seals ADD COLUMN reasons JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · Asking why is itself an event.
--
-- The value-bearing form of a reason — "you had 4 and the limit is 3" — is the
-- specificity the law demands AND the probe an adversary runs. It discloses
-- what the institution holds about a person, and it collapses threshold
-- discovery from a binary search over repeated attest-and-seal cycles into one
-- call. That is the structuring vector Ratchet exists to detect, handed out at
-- the front desk.
--
-- Refusing it is not an option: a creditor must give the reason. So the
-- disclosure is gated on authority and RECORDED. Nobody anywhere currently
-- records who asked why a person was refused, and for a regulated buyer the
-- record that the notice was produced is itself the compliance artifact.
--
-- Deliberately NOT pressure. Asking why is not resisting a determination, and
-- counting it as contestation would corrupt the wrongful-denial quadrant.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE seal_events DROP CONSTRAINT seal_events_kind_check;
ALTER TABLE seal_events ADD CONSTRAINT seal_events_kind_check
  CHECK (kind IN ('sealed', 'tainted', 'lapsed', 'clawed', 'expired', 'exercised',
                  'hardened', 'carve_out', 'merge_refused', 'disclosed'));
CREATE INDEX seal_events_disclosed_idx ON seal_events (workspace_id, occurred_at DESC)
  WHERE kind = 'disclosed';
