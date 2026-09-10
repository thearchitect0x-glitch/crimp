// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Record signatures: Ed25519 over the canonical bytes of a determination's
 * sealed core.
 *
 * WHY SIGN AT ALL. A record's hashes let a stranger check that the rule and
 * the values are what the record says. They do not let the stranger check
 * that THIS INSTITUTION issued the record — a fabricated record with correct
 * internal hashes verifies perfectly. A signature under a published key is
 * the difference between "internally consistent" and "issued by them".
 *
 * WHAT IS SIGNED. The sealed core (SPEC §7.0f): what was decided, under
 * which rule, on which fact digests, with which reasons and remedy — the
 * parts that never change. Not the state, not the events: those are the
 * record's history and they move. A signature made at seal time therefore
 * stays valid for the life of the record, whatever happens to it after.
 *
 * KEYS. One Ed25519 key per deployment, from SIGNING_KEY: the 32-byte seed,
 * base64. The public key is published at /.well-known/crimp-keys.json under
 * a `kid` derived from it, so a verifier can fetch it once and keep it
 * forever. Rotation is adding a key; old signatures verify under old keys.
 * The seed must be in escrow like BLIND_SECRET: lose it and every record
 * issued under it is still verifiable, but no new one can be issued under
 * the same identity.
 *
 * Ed25519 is deterministic — the same bytes and key give the same signature
 * — which is what lets the conformance vectors carry expected signatures.
 */
import { createPrivateKey, createPublicKey, sign, verify, createHash, type KeyObject } from 'node:crypto';
import { canonicalize } from './ids.js';

export const ALG = 'ed25519';

export interface Signature {
  kid: string;
  alg: typeof ALG;
  /** base64 of the 64-byte Ed25519 signature. */
  sig: string;
}

export interface PublishedKey {
  kid: string;
  alg: typeof ALG;
  /** base64 of the 32-byte raw public key. */
  public_key: string;
}

/* Ed25519 PKCS#8 / SPKI prefixes, so a raw seed or raw public key can be
   handed to node's KeyObject machinery without an ASN.1 library. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class Signer {
  private readonly priv: KeyObject;
  readonly publicKeyRaw: Buffer;
  readonly kid: string;

  constructor(seedBase64: string) {
    const seed = Buffer.from(seedBase64, 'base64');
    if (seed.length !== 32) throw new Error('SIGNING_KEY must be the 32-byte Ed25519 seed, base64-encoded.');
    this.priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const spki = createPublicKey(this.priv).export({ format: 'der', type: 'spki' }) as Buffer;
    this.publicKeyRaw = spki.subarray(SPKI_PREFIX.length);
    this.kid = kidOf(this.publicKeyRaw);
  }

  /** Sign the canonical bytes of a sealed core. */
  signCore(core: unknown): Signature {
    const sig = sign(null, Buffer.from(canonicalize(core), 'utf8'), this.priv);
    return { kid: this.kid, alg: ALG, sig: sig.toString('base64') };
  }

  published(): PublishedKey {
    return { kid: this.kid, alg: ALG, public_key: this.publicKeyRaw.toString('base64') };
  }
}

/** The first 16 hex of sha256 of the raw public key. Stable, short, collision-safe enough for a key list. */
export function kidOf(publicKeyRaw: Buffer): string {
  return createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 16);
}

export function verifyCore(core: unknown, signature: Signature, publicKeyRawBase64: string): boolean {
  const pub = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyRawBase64, 'base64')]), format: 'der', type: 'spki',
  });
  return verify(null, Buffer.from(canonicalize(core), 'utf8'), pub, Buffer.from(signature.sig, 'base64'));
}
