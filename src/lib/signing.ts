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
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, createHash, type KeyObject } from 'node:crypto';
import { canonicalize } from './ids.js';

export const ALG = 'ed25519';
/**
 * The second algorithm. ML-DSA-65 (FIPS 204), a lattice signature that a
 * quantum computer cannot forge. A record about a person may need to verify
 * in 2040; Ed25519 will not survive a cryptographically relevant quantum
 * computer, and re-signing history is exactly what a record must never
 * need. So a deployment may sign every core twice, and a verifier checks
 * whichever it can. Absent means not issued, never invalid.
 */
export const ALG_PQ = 'ml-dsa-65';
export interface Signature {
  kid: string;
  alg: typeof ALG;
  /** base64 of the 64-byte Ed25519 signature. */
  sig: string;
}
export interface SignaturePq {
  kid: string;
  alg: typeof ALG_PQ;
  /** base64 of the 3309-byte ML-DSA-65 signature. */
  sig: string;
}
export interface PublishedKey {
  kid: string;
  alg: typeof ALG | typeof ALG_PQ;
  /** Ed25519: base64 of the 32-byte raw public key. ML-DSA-65: base64 of the SubjectPublicKeyInfo DER. */
  public_key: string;
  /** A previous key stays published so the records it signed keep verifying after rotation. */
  status: 'current' | 'previous';
}
export interface SignerOptions {
  /** ML-DSA-65 private key, PKCS#8 DER, base64. Optional. */
  pqPrivateKeyDer?: string | null;
  /** Raw Ed25519 public keys this deployment signed with before, base64. Published, never used to sign. */
  previousPublicKeys?: readonly string[];
}

/* Ed25519 PKCS#8 / SPKI prefixes, so a raw seed or raw public key can be
   handed to node's KeyObject machinery without an ASN.1 library. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class Signer {
  private readonly priv: KeyObject;
  readonly publicKeyRaw: Buffer;
  readonly kid: string;
  private readonly pqPriv: KeyObject | null;
  private readonly pqPublicDer: Buffer | null;
  readonly pqKid: string | null;
  private readonly previous: PublishedKey[];
  constructor(seedBase64: string, opts: SignerOptions = {}) {
    const seed = Buffer.from(seedBase64, 'base64');
    if (seed.length !== 32) throw new Error('SIGNING_KEY must be the 32-byte Ed25519 seed, base64-encoded.');
    this.priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const spki = createPublicKey(this.priv).export({ format: 'der', type: 'spki' }) as Buffer;
    this.publicKeyRaw = spki.subarray(SPKI_PREFIX.length);
    this.kid = kidOf(this.publicKeyRaw);
    if (opts.pqPrivateKeyDer) {
      const priv = createPrivateKey({ key: Buffer.from(opts.pqPrivateKeyDer, 'base64'), format: 'der', type: 'pkcs8' });
      if (priv.asymmetricKeyType !== ALG_PQ) {
        throw new Error(`SIGNING_KEY_PQ must be an ${ALG_PQ} private key, PKCS#8 DER, base64; got ${priv.asymmetricKeyType}.`);
      }
      this.pqPriv = priv;
      this.pqPublicDer = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
      this.pqKid = kidOf(this.pqPublicDer);
    } else {
      this.pqPriv = null; this.pqPublicDer = null; this.pqKid = null;
    }
    this.previous = (opts.previousPublicKeys ?? []).map((b64) => {
      const raw = Buffer.from(b64, 'base64');
      if (raw.length !== 32) throw new Error('SIGNING_PREVIOUS_PUBLIC_KEYS entries must be 32-byte raw Ed25519 public keys, base64.');
      return { kid: kidOf(raw), alg: ALG, public_key: raw.toString('base64'), status: 'previous' as const };
    });
  }
  get hasPq(): boolean { return this.pqPriv !== null; }
  /** Sign the canonical bytes of a sealed core. */
  signCore(core: unknown): Signature {
    const sig = sign(null, Buffer.from(canonicalize(core), 'utf8'), this.priv);
    return { kid: this.kid, alg: ALG, sig: sig.toString('base64') };
  }
  /** The second signature, under the post-quantum key, when there is one. */
  signCorePq(core: unknown): SignaturePq | null {
    if (this.pqPriv === null) return null;
    const sig = sign(null, Buffer.from(canonicalize(core), 'utf8'), this.pqPriv);
    return { kid: this.pqKid!, alg: ALG_PQ, sig: sig.toString('base64') };
  }
  published(): PublishedKey {
    return { kid: this.kid, alg: ALG, public_key: this.publicKeyRaw.toString('base64'), status: 'current' };
  }
  /** Every key a verifier may need: the current ones, and the previous ones whose records still exist. */
  publishedKeys(): PublishedKey[] {
    const out: PublishedKey[] = [this.published()];
    if (this.pqPublicDer !== null) {
      out.push({ kid: this.pqKid!, alg: ALG_PQ, public_key: this.pqPublicDer.toString('base64'), status: 'current' });
    }
    return [...out, ...this.previous];
  }
}

/** Verify a post-quantum signature over a sealed core under a published ML-DSA-65 key (SPKI DER, base64). */
export function verifyCorePq(core: unknown, signature: SignaturePq, publicKeySpkiDerBase64: string): boolean {
  const pub = createPublicKey({ key: Buffer.from(publicKeySpkiDerBase64, 'base64'), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(canonicalize(core), 'utf8'), pub, Buffer.from(signature.sig, 'base64'));
}

/** Mint an ML-DSA-65 key pair for a deployment. The private key is escrowed like SIGNING_KEY. */
export function generatePqKeyPair(): { privateKeyDerBase64: string; publicKeyDerBase64: string; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync(ALG_PQ);
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    privateKeyDerBase64: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    publicKeyDerBase64: spki.toString('base64'),
    kid: kidOf(spki),
  };
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
