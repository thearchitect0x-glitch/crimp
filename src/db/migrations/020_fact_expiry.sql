-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- The third trigger. Fact expiry is a change that nothing writes, so the
-- sweep now asks on every pass which attestations ran out since each
-- determination was last examined. That is a range over expiry times per
-- workspace; without this index it is a scan over every attestation.
CREATE INDEX attestations_expiry_idx ON attestations (workspace_id, expires_at)
  WHERE expires_at IS NOT NULL;
