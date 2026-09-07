<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Assurance case

Why Crimp's security requirements are met, and where they are not.

An assurance case is an argument, not a checklist. This states what the system
must guarantee, what it defends against, where the trust boundaries sit, and
what evidence supports each claim. Every claim names the test or mechanism that
enforces it. **Where something is not defended, it says so** — a case claiming
more than it can support is worse than none.

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 1. What Crimp must guarantee

| # | Requirement | Why it matters |
|---|---|---|
| **R1** | **An agent cannot assert a conclusion.** It supplies a rule and facts; the outcome is derived. | The product. Every other guarantee is downstream of it. |
| **R2** | **Authority is a property of the credential**, never of a request. | An authority a caller can claim is not an authority. |
| **R3** | **An agent cannot lift what it sealed.** | The sentence the product is sold on. |
| **R4** | **A claw rule tightens and never loosens.** | Fixed before the sealer knew it would want one — the only reason it is worth anything. |
| **R5** | **An unknown never becomes a lapse.** | Guessing that a determination no longer applies silently frees somebody who is still bound. |
| **R6** | **Tenant isolation.** No workspace reads or affects another. | Multi-tenant by design; a leak here is a breach. |
| **R7** | **Crimp cannot recover a subject's identity.** | It holds determinations about people and must never hold the people. |
| **R8** | **Determinations are reproducible and append-only.** | A customer must not have to take our word for what was decided. |
| **R9** | **Hardening cannot lock out the account owner.** | A control no human can override is an outage, not a safety feature. |

## 2. Threat model

**Assumed capable adversaries:**

- **A compromised or prompt-injected agent** holding a valid key. *This is the
  primary adversary and the product's reason to exist.* It may submit arbitrary
  rules, arbitrary aliases, and call anything its scopes permit.
- **A determined subject** — the person a determination is against — probing
  through the institution's own agents across many sessions.
- **A malicious tenant** attempting to reach another workspace.
- **An attacker holding a copy of the database** but not the application
  secrets.
- **A careless operator** who could otherwise put determinations permanently
  out of reach.

**Explicitly out of scope:** an attacker who holds `AUTH_SECRET` or
`BLIND_SECRET`; a hostile maintainer; physical access to the database host.

## 3. The argument

**R1 — an agent cannot assert a conclusion.**
There is no parameter for one. `SealInput` has no outcome field, and
`src/api/schemas.ts` has no property that would accept one — with
`additionalProperties: false` and `removeAdditional` off, sending one is a
`400`. *Evidence:* `test/e2e/api.test.ts` posts `sealed_by: "custodian"` from an
agent key and asserts a 400; `test/integration/auth.test.ts` passes it past the
type system and asserts the stored row still reads `agent`.

**R2 — authority comes from the credential.**
`verifyKey` returns a `Principal`; every domain entry point takes it as its
first argument and reads `workspaceId` and `authority` from it. Issuance follows
the same ladder: a key mints only keys strictly below itself, cannot grant a
scope it does not hold, and cannot revoke a peer or superior. *Evidence:* six
tests in `test/integration/auth.test.ts`. *Mutation-verified:* removing the
mint-below-yourself rule, the scope-grant check, the revoked check, or the
revoke ladder each fails 1–2 tests.

**R3 — no self-reversal.**
`validateClawRule` requires the claw authority to strictly exceed the sealer,
and the database enforces it independently via
`CONSTRAINT seals_no_self_reversal CHECK (claw_authority <> sealed_by)`. An
`agent` may additionally require at most one level above itself, so a
compromised agent costs an operator an afternoon rather than bricking the
workspace. *Evidence:* `test/unit/lifecycle.test.ts`, `test/integration/seal.test.ts`.

**R4 — tighten, never loosen.**
`assertTightening` moves one way on every dimension: authority up, evidence
floor up (by domination, so a sideways move to an incomparable class is
refused), cooling-off longer. Pressure-hardening is itself checked against it,
so the automatic path cannot do what the manual path may not.

**R5 — an unknown never becomes a lapse.**
`classify(UNKNOWN)` returns `tainted`, and a tainted seal still binds.
*Mutation-verified:* changing it to `lapsed` fails two tests. The fuzz suite
additionally proves **monotonicity of knowledge** — attesting a new fact may
resolve an unknown but can never flip a known answer, which is the silent
reversal this product exists to prevent, hiding inside the product.

**R6 — tenant isolation.**
Every query is workspace-scoped from the principal. A cross-tenant lookup is a
`404`, never a hint that the record exists elsewhere. *Evidence:* isolation
tests in `seal.test.ts`, `auth.test.ts` and `insight.test.ts`.

**R7 — subjects are unrecoverable.**
Only `HMAC(BLIND_SECRET, workspace|type|value)` truncated to 128 bits is stored.
The workspace id is inside the MAC, so the same value in two workspaces is
uncorrelatable. `BLIND_SECRET` is separate from `AUTH_SECRET` and production
refuses to start if they match — rotating the blinding pepper does not rotate a
key, it orphans every determination, and separating them stops that happening
during a routine auth rotation.

**R8 — reproducible and append-only.**
The rule is stored as written and hashed in canonical form, where commutative
children are sorted so two agents expressing the same policy alike hash alike.
`seal_facts` records a digest of each value at seal time. Clawing sets a state
and writes an event; it deletes nothing.

**R9 — hardening has a ceiling.**
Pressure-hardening applies to `bind` only, never `permit` or `commit`, and can
never exceed the top authority. *Mutation-verified:* letting it harden a permit,
or removing the ceiling, each fails a test.

## 4. What is NOT defended

Read this section before relying on anything above.

**The attestation trust root belongs to the customer.** Crimp never fetches, so
an institution that attests false facts can produce a mathematically perfect
proof of a wrong decision. Admissibility narrows it — a claw demanding
disinterested evidence cannot be satisfied by an institution talking to itself —
but does not close it. Closing it would require holding customer credentials,
which would destroy the property the product is built on. **This is permanent.**

**Constant-time key comparison is not enforced by any test.** Replacing
`timingSafeEqual` with `===` passes the entire suite. A timing assertion
sensitive enough to catch it would be flaky, and a flaky security test is worse
than a documented gap. The *precondition* is enforced — `DECOY_MAC` must match a
real MAC in length or the length guard short-circuits and the comparison is
skipped — but the timing property itself is upheld by review, not by CI.

**A carve-out closes the direct route back, not every route.** A carve-out
detaches one alias from one subject and blocks a merge naming that subject. It
cannot stop a *later* merge, through some third subject, from re-associating
what an authority separated — the graph is transitive and a carve-out is a
single edge. The direct attempt is refused with `carve_out_standing` and every
merge is recorded, so the route that remains is visible after the fact rather
than prevented before it. Closing it properly means carrying carve-outs
forward through the merge closure, which is real work and wants a real case.

**A carve-out is not an un-merge, and nothing is.** It stops the wrong binding
applying from now on. It does not restore the subject a union destroyed and it
does not touch the determinations that union already produced — those stay on
the record, because rewriting history to hide a mistake is a worse property
than having made it.

**One lossy step in a merge.** Where two subjects hold the same fact, the
freshest assertion survives and the superseded one is deleted with its subject.
Crimp never stored historical values anyway, so nothing is lost that was ever
retrievable — but the merge is where that design decision becomes visible.

**`medium` aliases decide identity only if a workspace says so.** The default
merge threshold is `strong`, so a presentation whose strong alias is unknown
creates a new subject even when an email would have found an existing one. That
means more subjects and more `merge_required` than a laxer rule would produce.
It is the safe direction — an explicit merge is bounded, authorised and
recorded; an implicit one is none of those — but it is a real usability cost and
it is chosen, not accidental.

**A disclosure is gated and recorded, not prevented.** An operator who is
entitled to produce an adverse action notice can also map exactly where a
threshold sits, because those are the same request. The control is authority
plus an audit record, not refusal — refusal would break the legal obligation
the feature exists to meet. An operator key that leaks is therefore a
policy-disclosure risk as well as a data one.

**Disclosed values come from CURRENT attestations, not from the seal.** The
historical value is not stored anywhere, by design, so a notice produced long
after the determination may cite a value that has since changed. The digest in
the proof is what pins what the determination actually rested on.

**The correction channel is only as current as the sweep.** A determination
lapses when the worker reaches it, not the instant a fact changes. An
attestation or an erasure marks it due so it jumps the queue, but the latency
is real and it is bounded by worker cadence and backlog rather than by
anything stronger. `sweepLag()` reports it; do not assume it is zero.

**A single worker is a single point of failure for correction.** Multiple
replicas are safe — every transition is a compare-and-set — but nothing yet
alerts if the worker stops. A silently dead worker looks exactly like a
workspace where nothing has changed.

**Scopes are a tree, not a DAG.** A seal on `money.out` does not catch a refund
today. Widening later is safe; the gap is real now.

**Session identity in pressure is caller-declared.** An institution's own agent
supplies it, and a caller that lies only misleads itself — but the distinct-
session count that promotes a seal from `persistent` to `probing` is only as
honest as the caller.

**There is no deployment**, and nothing has been released yet — the release
machinery exists and is keyless, but no tag has been cut.

**Crimp cannot stop anything.** It reports determinations; enforcement belongs
to the caller. A caller that ignores a standing refusal is not prevented from
acting, and no part of this system claims otherwise.

**Rate limiting is per-key and approximate**, held in process memory. Multiple
instances do not share a counter.

## 5. Supply chain

`npm ci` from a committed lockfile. CI runs typecheck, unit, integration and
end-to-end tests against a real Postgres, a production dependency audit, CodeQL
with `security-and-quality`, a REUSE licence check, and a DCO gate — all on
every push and pull request. `main` carries a ruleset with **no bypass actors**:
every change needs a pull request and an approving review from somebody other
than its author, the maintainer included, verified by attempting a direct push
and being refused.

## 6. Continuity

A named successor holds credentials and has restored the system from the
runbooks without the maintainer present — 6 September 2026, 1h 30m, four
findings, all defects in the documents. See
[GOVERNANCE.md](GOVERNANCE.md). One rehearsal is not a guarantee; it is one
data point, and it produced four defects, which is the argument for running it
again when a production database exists.

## 7. How this document stays true

It is wrong the moment the code disagrees with it. Any change touching the
grammar, the authority ladder, the blinding construction or the trust boundary
updates this file in the same pull request, or the change does not land.
