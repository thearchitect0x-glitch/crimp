<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# NIST SSDF conformance

How Crimp is built, mapped to the four practice groups of the **Secure Software
Development Framework**, NIST SP 800-218 version 1.1.

**What this is.** A statement of what Deimos AI LLC actually does when building
Crimp, with a pointer to the file, workflow or test that makes each claim
checkable. Where a practice is not met, it says so.

**What this is not.** A certification. Nobody issues an SSDF badge. It is also
not a [CISA Secure Software Development Attestation](https://www.cisa.gov/resources-tools/resources/secure-software-development-attestation-form),
which is submitted to a federal agency buying the software. Crimp is built for
public benefits, Medicaid and prior authorization, where that attestation will be
asked for; this document is the substance it would rest on, published so it can
be read rather than asserted.

**Scope.** The Crimp API, worker, verifier and the format's site, in
[this repository](https://github.com/thearchitect0x-glitch/crimp). Figures below
were measured on 13 September 2026 unless a date says otherwise.

---

## PO — Prepare the Organization

**PO.1 — Define security requirements.** [`ASSURANCE_CASE.md`](../ASSURANCE_CASE.md)
states what Crimp must guarantee, the threat model, the argument for each
guarantee, and what is explicitly not defended. [`SECURITY.md`](../SECURITY.md)
names the properties the test suite does not enforce, so a reader knows which
guarantees are checked and which are only intended.

**PO.2 — Roles and responsibilities.** [`GOVERNANCE.md`](../GOVERNANCE.md) names
a maintainer and a successor. The successor holds credentials and admin rights,
and restored the system from the runbooks alone on 6 September 2026 without the
maintainer, in 1 hour 30 minutes, finding four defects in the documents.
**Still open:** direction rests on one person. Two people can act; one decides.

**PO.3 — Supporting toolchains.** Every pull request and every push to `main`
runs typecheck of source, tests and scripts; a reproducible-build check; unit,
integration and end-to-end suites against a real PostgreSQL; the published
conformance vectors; property-based tests; a production dependency audit; a
REUSE licence check; and a DCO sign-off gate. CodeQL runs on every push, every
pull request and weekly. OpenSSF Scorecard runs on every push to `main` and
weekly. Dependabot proposes updates to npm packages, GitHub Actions and container
base images weekly.

**PO.4 — Criteria for software security checks.** `main` admits a change only
when `build`, `reuse` and `dco` pass. Coverage floors are explicit in
`scripts/test.sh`: 90% statements, 85% branches, 90% lines, 85% functions,
measured over `src/**` across all three suites. Measured 13 September 2026:
**96.86% statements, 89.51% branches, 96.35% functions**, 495 tests.
**Gap:** coverage is enforced by `npm run coverage`, not yet in CI.

**PO.5 — Secure development environments.** Secrets live in the deployment's
secret store and never in the repository. GitHub secret scanning and push
protection are enabled. Production refuses to start without a signing key, with
the published test seed, or with a post-quantum key on a runtime that cannot use
it. **Partial:** the developer workstation is not covered by a documented
hardening standard.

---

## PS — Protect the Software

**PS.1 — Protect code from unauthorized access and tampering.** `main` carries a
ruleset with **no bypass actors**: no deletion, no force push, every change
through a pull request with an approving review from somebody other than the
last pusher, and stale approvals dismissed on a new push. Every commit a pull
request adds must carry `Signed-off-by`, certifying the
[Developer Certificate of Origin](https://developercertificate.org/). GitHub
requires two-factor authentication for everyone who contributes code.

**PS.2 — Verify release integrity.** Releases are signed keyless through
Sigstore: [`release.yml`](../.github/workflows/release.yml) attests the source
archive with a certificate bound to the workflow run and commit, and attaches the
Sigstore bundle and the in-toto provenance to the release beside the archive and
its checksum. The release itself needs no signing key to escrow, leak or lose.
The release tag is additionally signed with the maintainer's Ed25519 SSH key,
which GitHub reports as verified; nothing depends on that second signature.
[`docs/RELEASING.md`](RELEASING.md) gives the verification command. *No SLSA
level is claimed.*

**PS.3 — Archive and protect each release.** Every release is a tag on a public
repository with generated notes, a checksum and its attestation. The first, [v0.1.0](https://github.com/thearchitect0x-glitch/crimp/releases/tag/v0.1.0),
was published on 13 September 2026. **Gap:** no SBOM is attached.

The records Crimp issues are protected separately from its source: each is signed
with Ed25519 and, where configured, a second ML-DSA-65 (FIPS 204) signature;
previous public keys stay published after rotation; and daily RFC 6962 Merkle
roots can be anchored to a public timestamp, so a record can be shown to predate
a key compromise.

---

## PW — Produce Well-Secured Software

**PW.1 — Design to meet security requirements.** Crimp never accepts an outcome
from a caller: the caller submits the rule and the facts, and Crimp derives the
outcome. The rule grammar is bounded: at most 8 levels deep and 64 nodes, with no arithmetic, so no submitted rule can make evaluation non-terminating. An absent or expired fact evaluates to UNKNOWN, and UNKNOWN
cannot seal an adverse determination.

**PW.2 — Review the design.** Every change is reviewed by a second person.
Measured 13 September 2026: **19 of 19** merged pull requests carry a review by
somebody other than their author. The OpenSSF `two_person_review` criterion asks
for 50%.

**PW.4 — Reuse well-secured software.** Nothing is vendored or forked, so every
component updates in place. `npm audit --omit=dev --audit-level=high` gates CI.
Cryptography uses `node:crypto` only.

**PW.5 — Secure coding practices.** TypeScript strict mode across source, tests
and scripts. Every request body is validated against a JSON Schema at the route boundary with `additionalProperties: false` (29 schema objects in `src/`), so an unexpected field is rejected rather than silently dropped. Every source file carries an SPDX header, enforced by
the REUSE check.

**PW.6 — Configure build processes.** The build is reproducible, and
[`scripts/verify-reproducible.sh`](../scripts/verify-reproducible.sh) proves it in
CI: two clean builds from two checkout paths must be byte-identical and must not
contain the path they were built at. Measured 13 September 2026: 133 files,
byte-identical. Every GitHub Action is pinned to a full commit SHA, every
container base image and the CI database image by digest, and `npm ci` installs
from the committed lockfile. The container runs as a non-root user.
**Gap:** `tini` is installed from the Alpine repository without a pinned version.

**PW.7 — Review human-readable code.** CodeQL with the `security-and-quality`
query suite, plus the compiler in strict mode as a second static analyser, plus
the human review in PW.2.

**PW.8 — Test executable code.** 495 tests across unit, integration and
end-to-end suites, the latter two against a real PostgreSQL. Property-based
tests with fast-check cover rule validation, explanation and remedy search, at
20,000 runs per property in CI. The conformance vectors were derived from the
specification by an independent implementation, not from this code.
Fuzz properties are verified by mutation before they are trusted, as
[`CONTRIBUTING.md`](../CONTRIBUTING.md) requires.

**PW.9 — Secure settings by default.** Responses carry `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
strict-origin-when-cross-origin` and a `Permissions-Policy` denying geolocation,
microphone and camera; production adds HSTS. Per-key responses are `no-store`.
**Gap:** no `Content-Security-Policy` header is sent.

---

## RV — Respond to Vulnerabilities

**RV.1 — Identify vulnerabilities on an ongoing basis.** Dependabot, CodeQL,
Scorecard, secret scanning and the production dependency audit, as above.
Private reporting through GitHub Security Advisories, as `SECURITY.md` directs, with private vulnerability reporting enabled on the repository since 13 September 2026.

**RV.2 — Assess, prioritise, remediate.** [`SECURITY.md`](../SECURITY.md) commits
to a response within 72 hours and a first assessment within 7 days, and credits
reporters by name unless they ask otherwise.

**RV.3 — Root cause analysis.** Every fixed defect gets a regression test that
fails without the fix, as [`CONTRIBUTING.md`](../CONTRIBUTING.md) requires.
**Partial:** analysis is per defect, not a periodic review across defects.

---

## Summary of gaps

| Practice | Gap |
|---|---|
| PO.2 | Two people can act; one decides. |
| PO.4 | Coverage floors are enforced locally, not yet in CI. |
| PO.5 | No documented hardening standard for developer workstations. |
| PS.3 | No SBOM attached to releases. |
| PW.6 | `tini` installed without a pinned version. |
| PW.9 | No `Content-Security-Policy` header. |
| RV.3 | Root cause analysis is per defect, not periodic. |
