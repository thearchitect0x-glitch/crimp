// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** The deployment's signer, if SIGNING_KEY is set. Built once, on first use. */
import { config } from '../lib/config.js';
import { Signer } from '../lib/signing.js';

let cached: { key: string; signer: Signer } | null = null;

export function signer(): Signer | null {
  const key = config.signingKey;
  if (key === null) return null;
  if (cached === null || cached.key !== key) cached = { key, signer: new Signer(key) };
  return cached.signer;
}
