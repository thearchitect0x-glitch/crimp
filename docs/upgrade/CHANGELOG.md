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

## cap-01 · Delivery attestation as a precondition to non-response · 9 September 2026

**The brief's mechanism, and why it was not built as written.** The brief asks
that a rule referencing "failure to respond", "did not return renewal", *or
any non-response predicate* require a `notice_delivery` fact, and that a
synonym be rejected at commit. No list of words captures "any non-response
predicate"; the next synonym defeats it, and test (d) asks us to refuse
exactly that. So the enforcement is structural:

- **A fact catalogue** (`fact_catalogue`, migration 012). An operator declares
  each fact's name, type and class — `plain`, `non_response`, `delivery`. A
  `non_response` fact **cannot be written without naming the `delivery` fact
  that guards it** (CHECK constraint + domain check that the guard's class is
  `delivery`). Once a workspace has declared any fact, the set is closed: a
  committed rule, an inline rule, and an attestation may name only catalogued
  facts (`uncatalogued_fact`). A synonym is therefore not detected; it is a
  fact the programme never defined, and defining one is an operator's act on
  the record. A workspace with no catalogue behaves exactly as before —
  the 306 pre-existing tests are the proof.
- **The guard** (`applyGuards`, pure). Before evaluation, a guarded fact is
  withheld unless its guard holds (`delivered_status = delivered`). The
  evaluator is unchanged: it receives fewer facts, and three-valued logic
  makes "did not respond" UNKNOWN until "it reached them" is TRUE. The refusal
  names the guard: `facts_not_attested` with `guarded[].reason =
  delivery_unattested`, what it needs, and what was observed instead.
- **Applied on re-evaluation too.** A finding sealed on delivered mail becomes
  `tainted` when NCOA returns the notice, and the taint event says why.
  Tested empirically: seal → re-attest `returned` → sweep → tainted → re-attest
  `delivered` → sweep → sealed.
- **The guard fact is committed to the record** when it held, although the
  rule does not name it: the determination rested on the delivery as surely as
  on the non-response it unlocked. A withheld fact is not committed, because
  the evaluator did not read it. (SPEC §7.0c.)
- **`notice_delivery` is a convention, not a type.** The brief's fields
  (notice_id, channel, sent_at, delivered_status, evidence) are a family of
  scalar facts under a dotted prefix — `notice.renewal.delivered_status` —
  which the grammar already supports. The `delivery` class fixes
  `delivered_status` to `delivered | returned | unknown`; `allowed_values`
  on the catalogue does the same for any `str` fact an operator closes.
  Staleness is the existing fact expiry: delivery attested with an
  `expires_at` matching the response window. No grammar change, no new value.
- **Attester** (`attestations.attester`, `seal_facts.attester`): the key id
  that asserted the fact, on every attestation and on the record. The ground
  capability 10 stands on. SPEC §7.0b, optional.

**F1 closed — constant conclusions refused (SPEC §3.x).** `validateRule` now
refuses any subtree that evaluates the same under every assignment in which
its facts are present. Exact by construction: literals partition each fact's
values into cells no comparison can distinguish, and one representative per
cell is evaluated. Single-fact subtrees are always checked; multi-fact
subtrees up to **65 536** assignments, a bound the spec states so both
implementations refuse the same rules. Admission narrows; evaluation does
not, so `grammar_version` stays `1`.

**A pre-existing grammar/evaluator disagreement found by the new vectors:**
`a in [true, false]` was admitted by `validateRule` and refused by
`evaluate` for every fact type — a rule that could never run. The grammar now
refuses boolean set members. Vector renamed to say what it found.

**Tests.** 306 → 335 (29 new: 12 unit, 12 integration, 2 e2e, 2 fuzz
properties — one two-sided admission property replacing the old one, and one
that checks a "constant" verdict against random assignments the detector did
not pick). Fuzz 19 → 20 at 3 000 runs. Conformance 38 → 48 (reference; six
`refuse`, four `admit` — a new group, because a grammar that refuses
everything passes every refuse vector); the independent verifier stays at 30
— it implements evaluation and verification, not admission, a pre-existing
asymmetry now recorded.

**Second implementation.** No change: the verifier does not admit rules, and
guards are issuing-system behaviour that §7.0c proves invisible to it.

**Defects found by the new tests, in the new code:** the guard fact was never
loaded — `loadFacts` fetches what the rule references, and the delivery fact
is, by design, not in the rule — so every guard read "nothing attested".
Fixed by loading guards on the rule's behalf in both evaluation paths.

**Human to confirm.** Nothing legal is hard-coded. What a programme should
catalogue — which facts are non-response facts, which notice guards each —
is the programme's own data dictionary and is not something this code should
guess. `CHANNELS` (`mail`, `e_notice`, `portal`, `sms`) is exported as the
convention and enforced only where an operator closes a `.channel` fact to it.
