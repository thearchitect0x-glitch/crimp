// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Mint the deployment's ML-DSA-65 key. Prints the private key once, for
 * SIGNING_KEY_PQ, and the kid the published key will carry. Escrow the
 * private key exactly as SIGNING_KEY: lose it and no new record carries a
 * post-quantum signature; leak it and every record's second signature is
 * forgeable.
 *
 *   npx tsx scripts/keygen-pq.ts
 */
import { generatePqKeyPair } from '../src/lib/signing.js';

const k = generatePqKeyPair();
console.log(`SIGNING_KEY_PQ=${k.privateKeyDerBase64}`);
console.log(`# published kid: ${k.kid}  (ml-dsa-65, SubjectPublicKeyInfo ${Buffer.from(k.publicKeyDerBase64, 'base64').length} bytes)`);
