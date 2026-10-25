<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Releasing

## How to cut one

A release is a tag and one approval. Everything else is automatic.

```bash
# 1. Set the version. It must match the tag exactly; CI refuses otherwise.
npm version 0.1.0 --no-git-tag-version

# 2. Through review like anything else — main takes no direct pushes.
git checkout -b release-0.1.0
git commit -s -am "Version 0.1.0"
gh pr create --fill
# … approved and merged …

# 3. Tag the merged commit on main.
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The tag push starts the release job, which waits in the `release` environment
until a maintainer approves it: open the run under Actions and choose *Review
deployments*. Only `v*` tags may use that environment.

Before approving, check that the tag has no release yet:

```bash
gh release view vX.Y.Z
```

The answer must be `release not found`. The waiting run has published nothing,
so a release that is already there, published or draft, is not this run's. Do
not approve the run; find out where that release came from first.

Once approved, the job runs the full suite — typecheck, unit, integration,
end-to-end against a real Postgres, and a production dependency audit — then
builds a source archive, attests it, and publishes the release. **If any of
that fails, no release appears.** A release is the one artifact somebody might
run without reading it first.

## How to verify one

```bash
gh attestation verify crimp-v0.1.0.tar.gz --repo thearchitect0x-glitch/crimp \
  --signer-workflow thearchitect0x-glitch/crimp/.github/workflows/release.yml --source-ref refs/tags/v0.1.0 \
  --deny-self-hosted-runners
```

`--repo` alone accepts an attestation made by any workflow in this repository,
on any branch, so a workflow planted on a branch could attest a file of its own.
`--signer-workflow` and `--source-ref` accept only `release.yml` running for
that tag, and `--deny-self-hosted-runners` only GitHub's own runners.

This strict check needs gh 2.102.0 or later (`gh --version`). From 2.68.0 to
2.101.x, gh accepts the same flags but matches them loosely: `--signer-workflow`
against only the start of the signing certificate's identity, and `--source-ref`
ignoring case, so a workflow or a tag with a look-alike name could pass. Older
versions refuse the command (`--source-ref` arrived in 2.68.0), which fails safe.

There is no key to import and no keyserver to trust. The attestation is a
Sigstore certificate bound to the GitHub OIDC identity of the workflow run that
produced the file, recorded in a public transparency log.

Every release also carries the attestation beside the archive, for verifiers
that do not use GitHub and for OpenSSF Scorecard, which looks for it there:

| Asset | What it is |
|---|---|
| `crimp-vX.Y.Z.tar.gz.sigstore.json` | The Sigstore bundle: the signature, its certificate, and the transparency log entry |
| `crimp-vX.Y.Z.tar.gz.intoto.jsonl` | The in-toto provenance statement, as a DSSE envelope |

```bash
gh attestation verify crimp-v0.1.0.tar.gz \
  --bundle crimp-v0.1.0.tar.gz.sigstore.json \
  --repo thearchitect0x-glitch/crimp \
  --signer-workflow thearchitect0x-glitch/crimp/.github/workflows/release.yml --source-ref refs/tags/v0.1.0 \
  --deny-self-hosted-runners
```

To check the archive is byte-for-byte what was published:

```bash
sha256sum -c crimp-v0.1.0.tar.gz.sha256
```

## Why keyless, and not a signed tag

A GPG key is one more secret to escrow, one more thing a successor can turn out
not to have, and one more way for a release to become unverifiable because
somebody lost a laptop.

[GOVERNANCE.md](../GOVERNANCE.md) names continuity as this project's largest
risk. Introducing a private key that must survive the maintainer works directly
against that, in exchange for a familiarity most verifiers do not actually use —
the number of people who check a GPG signature on a source tarball before
running it is close to zero, and a ceremony nobody performs is not security.

Sigstore has nothing to store, nothing to leak and nothing to lose. Ratchet
reaches the same conclusion by a different route: it publishes to npm with
`--provenance`, which is the same machinery.

**The tag is signed anyway, and nothing depends on it.** The maintainer's git
signs every annotated tag with an Ed25519 SSH key, so `v0.1.0` carries a
signature GitHub reports as verified. That is a second, independent check for
anyone who wants one. A release still verifies completely without it, and a
successor who does not hold that key can cut the next release with an unsigned
tag and lose nothing the attestation provides. Because signing is forced in that
configuration, a tag needs a message: `git tag -a vX.Y.Z -m "…"`, not a bare
`git tag vX.Y.Z`, which fails with *no tag message?*.

## What provenance proves, and what it does not

It answers **which workflow, at which commit, built this file**.

It does not answer **whether that commit was any good**. A perfectly genuine
attestation over a bad commit is still an attestation over a bad commit. What
addresses the second question is the ruleset on `main`: no bypass actors, every
change through a pull request, an approving review from somebody other than the
author. Provenance and review answer different halves and neither substitutes
for the other.

## Versioning

Semantic versioning, with one project-specific rule that outranks it:

**The predicate grammar cannot be narrowed in any release, ever — major
included.** Every rule ever sealed is evaluated by that grammar forever, and a
determination that stops being re-evaluable is a determination that silently
becomes `tainted`. The grammar may be widened where existing rules keep their
exact meaning. That is not a compatibility policy, it is a correctness one, and
a major version number does not buy an exemption from it.
