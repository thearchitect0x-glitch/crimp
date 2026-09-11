// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** The deployment's signer, if SIGNING_KEY is set. Built once, on first use. */
import { config } from '../lib/config.js';
import { Signer } from '../lib/signing.js';

let cached: { key: string; signer: Signer } | null = null;

export function signer(): Signer | null {
  const key = config.signingKey;
  if (key === null) return null;
  const pq = config.signingKeyPq; const prev = config.signingPreviousPublicKeys;
  const fingerprint = `${key}|${pq ?? ''}|${prev.join(',')}`;
  if (cached === null || cached.key !== fingerprint) {
    cached = { key: fingerprint, signer: new Signer(key, { pqPrivateKeyDer: pq, previousPublicKeys: prev }) };
  }
  return cached.signer;
}
