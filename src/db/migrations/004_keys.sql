-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- API keys, and the reason this migration exists before the HTTP surface does.
--
-- Until now `sealed_by` arrived as a function argument. Every invariant in the
-- product rests on authority being true — an agent may not lift what it sealed,
-- a claw must exceed its sealer, an agent may not put a determination beyond an
-- operator — and all of it was resting on the caller honestly declaring which
-- one it was. A caller could pass 'custodian' and reverse anything.
--
-- Authority is a property of the CREDENTIAL, never of the request body. After
-- this migration there is nowhere in the API to state your own authority.
--
-- KEY ISSUANCE FOLLOWS THE SAME LADDER IT ENFORCES. A key may only mint keys
-- strictly below itself, so an agent key mints nothing at all. Without that,
-- the ladder is decorative: any agent could mint itself an operator key and
-- claw its own determinations, which is precisely the attack invariant III
-- exists to prevent, one level of indirection away.

CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Lookup handle. Sent in the clear as part of the key so verification is one
  -- indexed read rather than a scan over every hash in the table.
  prefix        TEXT NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{12}$'),

  -- HMAC-SHA256 of the secret, peppered with AUTH_SECRET. Never the secret,
  -- never a bare hash: a bare hash of a high-entropy secret is fine right up
  -- until the table leaks and someone has a GPU.
  secret_mac    TEXT NOT NULL CHECK (secret_mac ~ '^[0-9a-f]{64}$'),

  authority     TEXT NOT NULL REFERENCES authority_levels(level),
  scopes        TEXT[] NOT NULL DEFAULT '{}',

  label         TEXT NOT NULL,
  -- Which key minted this one. Null only for the workspace's first key.
  issued_by     TEXT REFERENCES api_keys(id),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX api_keys_workspace_idx ON api_keys (workspace_id) WHERE revoked_at IS NULL;

-- Every mint and revoke is on the record. An authority ladder whose issuance
-- history is not auditable cannot be reasoned about after an incident.
CREATE TABLE key_events (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('minted', 'revoked')),
  by_key_id    TEXT,
  authority    TEXT NOT NULL,
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX key_events_workspace_idx ON key_events (workspace_id, occurred_at DESC);
