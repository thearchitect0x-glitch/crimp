<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# `web/` — the format's home

Static files, no build step in front of them. What is here is what gets
served: by the API at `/` (so a running Crimp answers `GET /verify.html`),
or by any static host once the directory is copied somewhere public.

## What is generated, and from what

| Page | Source of truth |
|---|---|
| `index.html` | `scripts/site/index.template.html` + counts from the vectors and the spec's version line |
| `spec/index.html`, `spec/SPEC.md` | `docs/SPEC.md` |
| `spec/extensions.html`, `spec/extensions.md` | `docs/spec/extensions.md` |
| `verify.html` | `spec/verifier.html` (the standalone browser verifier) |
| `spec/verifier.mjs`, `spec/verify-cli.mjs`, `spec/vectors.json` | the same files under `spec/` |
| `404.html`, `robots.txt` | `scripts/site.ts` |

Hand-written and kept: `assets/style.css`, `brand/`.

Regenerate with `npm run site`. A test regenerates in memory and compares
with what is committed, so the site cannot drift from the specification it
renders — editing `docs/SPEC.md` without re-running the generator fails the
suite, on purpose.

## The keys endpoint is not here

`/.well-known/crimp-keys.json` is served by each **issuing** deployment,
because the signature on a record is the issuer's. This site holds the
verifier; it never holds anyone's keys.

## Publishing — not yet

Nothing in this repository publishes this directory. The intended shape,
when the time comes: a separate public repository holding the format —
`docs/SPEC.md`, `docs/spec/extensions.md` (with its `.ots` proof), `spec/`,
and this directory — from which a static host (Cloudflare Pages, GitHub
Pages, or the same Fly app) serves it. The product repository stays
private. That step waits on the provisional application, for the reason
recorded in `docs/upgrade/BLOCKERS.md` and the merge order.

Until then, set `VERIFY_URL` to nothing. Once the site is live, set it to
the site's origin and every notice will say where to check.
