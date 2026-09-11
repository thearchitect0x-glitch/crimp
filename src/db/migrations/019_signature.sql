-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- Phase 2 · The issuer's signature over the sealed core (SPEC §7.0f).
--
-- Made once, at seal time, over the parts of the record that never change,
-- under the deployment's Ed25519 key. Null on every seal that predates this
-- migration and on any deployment running without SIGNING_KEY; a verifier
-- that finds no signature reports "unsigned", never "invalid".
ALTER TABLE seals ADD COLUMN signature JSONB;
