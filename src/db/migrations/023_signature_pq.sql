-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- A second signature over the same sealed core, under ML-DSA-65 (FIPS 204),
-- when the deployment holds a SIGNING_KEY_PQ. A record about a person may
-- need to verify in 2040; this is the signature that survives a quantum
-- computer. Null where not issued; a verifier reports absent, never invalid.
ALTER TABLE seals ADD COLUMN signature_pq JSONB;
