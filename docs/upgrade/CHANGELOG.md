<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Upgrade changelog

One entry per capability as it lands, in the order it actually landed. Each
entry names the capability number, the spec section it touched, whether the
second implementation needed a change, and what a human still has to confirm.

## Phase 0 · 9 September 2026

- `00-capability-map.md` written against `integration-check` (73e1dc2). Base
  measured green: 287 tests, 32 × 2 conformance vectors, 19 fuzz properties.
- Finding F1 recorded: a presence *test* is expressible via
  `any[a=v, a≠v]`; absence still cannot seal. Tautology-over-present-values
  detection proposed for Phase 1 alongside capability 1.
- Dependency order recorded: capability 8 (rule registry) underlies 1(d), 6, 7
  and 10, and is proposed first. No format change made.

## cap-08 · Ruleset versioning with legal citations · 9 September 2026

**Spec.** §7.0a (new, additive): optional `as_of` and `rule_ref` on a record;
`rule_ref.version` MUST equal `rule_hash`. §8 step 3 extended with that one
check and a rule that a verifier MUST NOT require the registry to exist.
Version bumped 0.1 → 0.2. Old records validate unchanged — vector
"a record without rule_ref or as_of is a valid record" asserts it.

**Domain.** `src/domain/registry.ts`: `declareRuleset`, `commitRule`,
`closeRule`, `resolveRule`, `ruleHistory`. Migration `011_registry.sql`.
Design decisions, each resolved from the code rather than guessed:

- **Version IS the canonical-form hash.** Immutable by construction; the same
  policy text committed in any order or any workspace is one version. A
  concurrent duplicate commit is a replay (`already_committed`), not an error.
- **One version in force per instant, enforced by the database** — an
  `EXCLUDE USING gist` constraint over `tstzrange(effective_from, effective_to)`.
  Overlap is refused with the clashing versions named. `closeRule` is the one
  change a committed version admits, and it records `closed_by` / `closed_at`.
- **The seal keeps its rule inline.** `rule_ref` is a snapshot beside it,
  stored in the record-format shape so the proof export is a pass-through.
  Registry selection happens in the seal path *before* evaluation; the
  evaluator receives a concrete rule and still cannot see a clock.
- **Rulesets are not scopes.** A rule may declare a scope; a seal under it must
  sit inside that scope (`rule_scope_mismatch`).
- **Committing is an operator act**: `rules:write` + `rules:read` scopes,
  neither in `AGENT_SCOPES`, commit gated on `operator` above the scope.
- **Citations are shape-checked, not looked up**: CFR, USC, or a bounded
  free form for state law. The empty string is refused — "cite it later" is
  how a determination nobody can trace to a law gets made.
- `SealInput.rule` is now optional *only* when `ruleRef` is given; both given
  must agree (`rule_ref_mismatch`). Neither given is refused.

**Tests.** 287 → 306 (19 new: 13 integration, 6 e2e). Conformance 32 → 38
(reference) and 24 → 30 (independent verifier): new `record` group, 3 vectors.
The stated claim "a later law change does not alter historic evaluation" is
tested empirically: seal under v1, close v1, commit stricter v2, re-attest,
sweep — the determination stays `sealed`, and a fresh determination about a
date after the change is `not_applicable` under v2.

**Second implementation.** `spec/verifier.mjs` and the embedded copy in
`spec/verifier.html` gained one step, `rule ref`, emitted only when the field
is present. `scripts/conformance-verifier.mjs` runs the `record` vectors
through `verify()` itself rather than re-implementing the check.

**Blocker.** Retroactive application (the brief's config flag) → `BLOCKERS.md`
B1. Not implemented, and no column recorded, because substituting a successor
rule at re-evaluation changes `rule_hash` and therefore what the record is.
Recommendation there: treat a retroactive change as an authority act (commit
successor, explicitly re-seal), not a sweep.

**Defects found by the new tests, in the new code:** the citation class
rejected `&` (every "Welf. & Inst. Code" citation); the overlap diagnostic ran
inside an already-aborted transaction. Both fixed before commit.

**Observed, not changed.** `Proof.verify` crosses the wire as-is with camelCase
keys (`verify.ruleHash`, `verify.valueDigest`) — a pre-existing leak across the
`serialize.ts` line. Renaming is a wire-contract change outside this
capability; recorded here for the report.

**Human to confirm.** Nothing legal in this capability: no days, months or
citations are hard-coded. The citation *grammar* (`validateCitation`) should
be reviewed by whoever will commit real rules, since it decides what a
programme may cite.
