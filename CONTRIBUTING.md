# Contributing

## Certificate of origin

Every commit must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/) 1.1:

    git commit -s

`Signed-off-by:` asserts you wrote the change or have the right to submit it
under this project's Apache-2.0 licence. CI rejects commits without it.

## What an acceptable contribution looks like

1. **It compiles under strict TypeScript.** `npm run typecheck` covers `src`,
   `test` and `scripts`. `noUncheckedIndexedAccess` is on and stays on.
2. **It has a test at the right layer.** See the testing policy below.
3. **It explains why, not what.** The code says what. Comments that narrate the
   code are noise; comments that record the reason a decision was made are the
   only durable part of a codebase.
4. **It does not weaken a documented guarantee.** If a change makes a claim in
   the README, the assurance case, or `docs/handoff/` untrue, the claim changes
   in the same commit or the change does not land.

## Testing policy

This is a formal requirement, not a preference.

**Any change that adds or alters functionality MUST include a test.** A pull
request that changes behaviour without one will not be merged.

Layer by intent:

| Layer | For |
|---|---|
| `test/unit` | Pure logic — grammar validation, evaluation, canonicalisation, hashing |
| `test/unit/fuzz-*` | Properties that must hold for *every* input, not the cases someone thought of |
| `test/integration` | Real Postgres — state transitions, concurrency, tenant isolation |
| `test/e2e` | Real HTTP through `app.inject` — auth, validation, headers, limits |

A change to any of these areas **must** come with a test: rule semantics,
authority ordering, tenant isolation, seal lifecycle, attestation handling,
authorization.

**Fuzz properties must be verified by mutation.** Break the implementation on
purpose, watch the property fail, then restore it. A property that has never
failed is a property you cannot trust — two of Ratchet's first three passed
against code that was already broken.

**Regression tests are required for fixed bugs.** A bug fixed without a test
that would have caught it is a bug scheduled to return.

## Coding standards

- ESM throughout; `.js` extensions in relative imports, required by `NodeNext`.
- Wire format is `snake_case`; the domain is `camelCase`. Conversion happens in
  exactly one file.
- Money is integer micro-USD. Never floats.
- Errors are `ApiError` with a stable machine-readable `code`. Agents branch on
  codes; changing one is a breaking API change.
- Every source file carries an SPDX header.

Enforced by `npm run typecheck` in CI. Style that a compiler cannot check is
settled by review, not by argument.
