<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Go-live runbook

What happens on the day the provisional's filing receipt exists, in order.
Nothing here is done before that receipt: the format, the site and the
repository stay private until the filing date is real.

## 0 · The receipt

Application number, confirmation number, filing date, saved beside the
package and recorded in the project notes. Twelve months from the filing
date is the non-provisional deadline; put it in two calendars.

## 1 · Keys, before the first real record

Two signing keys, each generated once, on a machine you control, and
escrowed with two holders before any record is issued. A record signed
under a key that is later lost can still be verified (the public key stays
published); a record signed under a key that leaks can be forged from that
moment, so the leak procedure below matters more than the generation.

```bash
# Ed25519, the signature every browser can check: 32 random bytes, base64.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
# ML-DSA-65, the signature that survives a quantum computer. Node 24+.
npm run keygen:pq
```

Set `SIGNING_KEY` and `SIGNING_KEY_PQ` in the deployment's environment.
`BLIND_SECRET` is generated the same way as the Ed25519 seed and escrowed
the same way; losing it means no new record can be issued under the same
identity, which is worse than losing a signing key.

Production refuses to start without `SIGNING_KEY`, with the published test
seed, with `SIGNING_KEY_PQ` on a runtime that cannot use it, or without
`web/index.html` and `spec/verifier.mjs` in the image. Read the boot log:
it states FIPS mode, the OpenSSL version and whether the second signature
is being issued.

## 2 · Rotation and leak

To rotate the Ed25519 key: generate a new seed, move the old **public** key
(base64 of the 32 raw bytes, from `/.well-known/crimp-keys.json`) into
`SIGNING_PREVIOUS_PUBLIC_KEYS`, set the new seed as `SIGNING_KEY`, restart.
Records signed before the rotation keep verifying: the previous key is
published as `previous`. Never remove a previous key while a record it
signed exists.

On a suspected leak: rotate immediately as above; publish the date of the
suspected compromise beside the key set; and tell verifiers to run
`verify-cli.mjs --require-pq` for records after that date, since the
second signature cannot be forged by whoever holds the Ed25519 key. The
transparency roots (below) are what prove a record predates the leak.

## 3 · The transparency anchor

The worker closes each day into Merkle roots on its own. Anchoring the
global root to a public timestamp is a separate, opt-in step, so the
worker never makes an outbound call:

```bash
npx tsx scripts/anchor-roots.ts
```

Run it daily after the day closes (any time after 00:10 UTC). It submits
each unanchored global root to the OpenTimestamps calendars and records
the proofs on the root, once. The proofs are pending until the calendars
commit to Bitcoin, typically within hours; `ots upgrade` (the reference
client) completes them. `GET /.well-known/crimp-roots.json` publishes the
roots and their anchors; `GET /v1/seals/:id/inclusion` gives a record its
path to them.

## 4 · The site and the endpoints

The API serves the format's home at `/`, the verifier at `/verify.html`,
the specification, the vectors, the CLI, the published keys at
`/.well-known/crimp-keys.json` and the roots at `/.well-known/crimp-roots.json`.
Set `VERIFY_URL` to the public address of `/verify.html`; every notice
prints it. Put the deployment behind TLS; nothing in the record depends
on it, but the notices and the person's copy travel over it.

The worker must be a long-running process (never serverless): it is what
closes days, records expiry, and runs drift and breadth. Several replicas
are safe.

## 5 · What may now be said

"Patent pending" from the filing date, for what the specification
describes. The format is published as prior art on purpose (`docs/SPEC.md`,
the site); the measurement and correction mechanisms are what the
provisional covers. The investor packet still omits the measurement
mechanism until counsel says otherwise.

## 6 · The first programme

`src/programmes/snap.ts` is a complete SNAP configuration with every legal
number marked `TODO(legal-confirm)`. Before the first real determination,
each of those numbers is confirmed against the current CFR and the state's
own rules by a person, and the confirmation is committed with a citation.
The same applies to `clocks.config.ts`, `notice.config.ts` and
`restoration.config.ts`.
