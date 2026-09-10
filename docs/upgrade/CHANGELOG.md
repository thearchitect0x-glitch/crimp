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

## cap-02 · Minimal correction sets — the remedy · 9 September 2026

**Spec.** §7.0d (new, additive): optional `remedy` on a record — every
*minimal* set of fact changes that moves the rule to `target`, each fact
described by its **cell** (every clause on that fact, with the truth it must
take). Normative semantics for "cell", "correction set", "minimal", ordering,
and the bound (**65 536** evaluations, one per distinct cell per fact).
Verification of *effectiveness* specified; minimality declared a search
property a non-searching verifier does not claim.

**Domain.** `src/domain/remedy.ts`: `corrections(rule, facts, target)`, pure;
`favourable(disposition)`; `REMEDY_BOUND`. Migration 013: `seals.remedy`.

- **Reuses the F1 partition.** `representatives()` (rule.ts) is now exported:
  the same cells that make "every value" finite for the constant-conclusion
  check make the remedy search exact. One mechanism, two uses.
- **Value-free by construction.** A remedy is the rule's own literals
  rearranged. It never carries what a fact *is*, so it sits at the same
  sensitivity as `reasons` and is returned to the sealer and exported in the
  proof without the disclosure gate. `wouldHaveNeeded` (the value-bearing
  form) stays behind `seals:disclose`, as before.
- **Direction follows disposition.** `bind` is a refusal: the remedy is what
  makes it lapse (`target: false`), stored on the seal and in the record.
  `permit` is a grant: a permit that did not apply returns what would earn it.
  `commit` has no side, so `null`. A refusal that did not apply also gets
  `null` — there is nothing to remedy in not being refused. An undecided
  refusal (`facts_not_attested`) carries the remedy in its error detail beside
  `missing`, so "attest these" comes with "in which cells".
- **Stored at seal time**, like the reasons, because it is derived from facts
  kept only as digests. A replay returns the stored remedy, not a fresh one.
- **Every minimal set, every cell.** Two cells for the same fact are two
  remedies (`any[a=1, a=2]` from `a=0` has two). Found by re-reading the spec
  text I had just written against the code: the search broke after the first
  witness per subset. Fixed and tested before commit.

**Tests.** 335 → 357 (22 new: 15 unit incl. minimality checked by brute force
against the evaluator for every reported set, 4 integration, 3 fuzz
properties — effectiveness, minimality-by-deletion, determinism). Fuzz
20 → 23 at 2 000 runs. Conformance 48 → 52 (reference: four `remedy` vectors,
hand-derived) and 30 → 34 (independent verifier: each vector's sets run
through `verify()` as a held-values record and must be *effective*).

**Second implementation.** `spec/verifier.mjs` and the embedded copy in
`verifier.html` gained one step, `remedy · effective`, and a `witness()`
that picks a member of a described cell the same way the issuer partitions —
so if the issuer found a cell, the verifier finds a member of it.

**Two expectations I had wrong, caught by my own tests.** (1) A ten-clause
conjunction with every clause failing does *not* exceed the bound: 59 048
evaluations, and 1 023 once representatives in the same cell are tried once.
The bound is real at seventeen (2¹⁷ − 1 > 65 536), which is what is now
tested. (2) "Already at target" spent evaluations finding nothing; it now
returns before searching.

**Not done, deliberately.** `deadline` — the brief's "if a clock applies" —
waits for capability 3, where clocks exist; a field nothing fills is the
pattern this codebase distrusts. "Acceptable sources" is not stored: the
sweep acts on any declared source, and stating a narrower list to a person
would be false. The catalogue (cap-01) and `fact_sources` are where a notice
renderer (cap-04) can look up a fact's type and the workspace's sources.

**Human to confirm.** Nothing legal. The bound (65 536) is an engineering
choice stated in the format; if a programme's rules routinely exceed it, the
number should be revisited *in the spec*, not in the code alone.

## cap-03 · Clocks, and the findings they produce · 9 September 2026

**Design divergence, recorded.** The brief says "clocks as facts" with a
`clock` fact type carrying a status. A clock here is a **record-bound object
with its own status, not a fact a rule can read**, and the evaluator cannot
see it. The reason is in the brief's own next sentence — a missed clock is
"never a change to the beneficiary outcome" — and a rule that could read
`status = missed` is precisely a change to the outcome driven by the
agency's lateness. The two requirements are met by making the second one
structural: there is no code path from `clocks` to a seal's state.

**What was built.**
- `clocks.config.ts`: seven federal deadline clocks, each `TODO(legal-confirm)`
  with its citation — Medicaid 45/90-day determinations (42 CFR 435.912(c)(3)),
  SNAP 30-day and 7-day expedited (7 CFR 273.2(g)(1), (i)(3)(i)), prior
  authorization 7-day standard and 72-hour expedited (42 CFR 438.210(d) as
  amended by CMS-0057-F), fair hearing 90-day (42 CFR 431.244(f)(1)).
  Intervals in hours so a 72-hour clock is not special.
- Migration 014: `clocks`, `findings`, `finding_classes` (reference table,
  same reason as `seal_event_kinds`). A finding carries no subject id.
- A clock **starts from an attested event** — the caller states when the
  application was received, as a claim by a named source, through
  `POST /clocks` (`attestations:write`). Idempotent while running.
- It is **met** by a seal for the subject in or around its scope (permit or
  bind), or by an attestation of a named fact (`fair_hearing_90_day` →
  `adjudication.ruling`, the name capability 6 will use). **Missed** once the
  *database's* clock says due has passed — the Docker clock-drift lesson from
  the earlier sessions, applied. A late resolution records `resolved_at`, so
  lateness is a number.
- A missed clock is an `agency_timeliness` **finding**, once per clock by
  partial unique index — idempotent under two workers by construction.
- The sweep advances clocks for every workspace with one running, whether
  or not any determination is due: a programme that sealed nothing this week
  still owes somebody a decision by Friday.
- `GET /insight/timeliness`: per clock, running / met / missed, mean hours to
  meet, mean hours late, unresolved — the 42 CFR 433.112(b)(15) number.
  `GET /findings?class=`. Both `insight:read`; agents cannot read findings.
- Erasure deletes a person's clocks and keeps the findings: the clock was
  about the person, the finding is about the agency.

**Stated honestly.** A determination clock is met by *any* seal — a favourable
outcome an institution does not seal as a `permit` leaves no record and is
invisible to the clock, as to everything else. An institution that wants its
timeliness measured seals its grants too.

**Blocker B2.** `advance_notice_10_day` (42 CFR 431.211) is a *minimum
interval* between notice and effect, not a deadline, and nothing on the
record marks "took effect". Modelling it honestly needs an `effective_at` on
a refusal — a behaviour and format decision in the person's favour. Written
up in `BLOCKERS.md`; not shipped as a dead config entry.

**Tests.** 357 → 367 (9 integration, 1 e2e): created on open with due from
config; replay while running; unknown name and future start refused; met by
a seal in scope on time with no finding; broader scope meets, unrelated scope
does not; missed → finding once, second sweep silent; late resolution records
hours late and the timeliness figure reports it; met by attested fact; a
finding never changes the determination and a clock survives re-evaluation;
erasure removes the clock and keeps the finding.

**Second implementation / format.** None: clocks and findings are outside the
determination record by design. They will be documented in
`docs/spec/extensions.md` (Phase 2) as finding classes.

**Human to confirm.** Every interval and citation in `clocks.config.ts`;
whether the deployment's state has tighter standards; the CMS-0057-F
compliance date that applies to the payer; and B2.

## cap-04 · Notice as derivation · 10 September 2026

**What a notice is here.** A pure function of the record. `deriveNotice(proof,
disclosed?, clocks, catalogue)` rearranges what is already sealed — outcome,
rule with citation and effective date, the clauses that decided it, the facts
relied on with sources, the remedy (cap-02), the clocks (cap-03), and the
programme's appeal rights — into one object; `renderText` and `renderHtml`
lay it out. Nothing is added, nothing is "now", so the same record yields the
same bytes forever, and the tests assert exactly that on a real record.

**No generated prose, enforced by shape.** A clause is rendered from a fixed
table of operator phrases; a negated clause is said with the *complement*
operator ("is at most 2000", not "it is not the case that it is more than
2000"), which is exact because the grammar is total over a typed fact and
which halves the reading grade. Appeal rights are config with a citation
(`notice.config.ts`: Medicaid, SNAP, prior authorization — each
`TODO(legal-confirm)`); a scope whose programme has no entry is **refused**
(`programme_not_configured`) rather than issued without appeal rights. Labels
come from the catalogue's `description` where one exists, so the page says
"Monthly household income", and the dotted name otherwise.

**Two fidelities, kept.** A notice without values names the clause, the fact
and its source. `values: true` goes through `disclosure()` — operator
authority, recorded as a `disclosed` event — because a notice with values IS
a disclosure and this module must not be a second door. Tested: an agent
asking for values is refused and nothing is recorded; an operator asking gets
them and the event count goes to one.

**Readability, reported.** Flesch–Kincaid over the plain-text rendering, with
the usual syllable heuristic, against the brief's target of 8. Never enforced.
The reference notice in the unit fixture measures **grade 10.2**
(143 words, 8 sentences) — above target, and honestly so:
citations, identifiers and the fixed appeal text count as words a person has
to read. Where the grade lands is now a number the programme can see and
work on in config, which is the point of reporting rather than blocking.

**Translation, hook only.** `NoticeTranslator` supplies labels and fixed
appeal text for a language; the record is never translated (a fact name is
an identifier, a citation is a citation). No implementation ships. Asking for
a language without a translator is `language_unavailable`, not English with
a shrug.

**API.** `POST /seals/:id/notice?format=json|text|html&values=&language=` —
a POST like the disclosure, because with values it records one.

**Tests.** 367 → 379 (8 unit, 3 integration, 1 e2e): determinism and
no-"now"; fixed statement per (disposition, state); unconfigured programme
refused; catalogue label used in reasons and remedy; complement phrasing;
values only when disclosed; HTML escaping of record content; reading grade
reported not enforced; disclosure gate and event on the real path; translator
hook replaces labels and appeal text and leaves the citation alone; the three
wire formats.

**Two things I had wrong, caught by the tests.** `wouldHaveNeeded` is defined
only for a clause that *failed*; in a refusal the clause *held*, so it never
appears — the remedy is what answers "what would change this", and the test
now says so. And an empty "lead" line was emitted before a single-set remedy.

**Second implementation / format.** None: a notice is derived from the
record and is not itself part of it.

**Human to confirm.** Every appeal window, citation and sentence in
`notice.config.ts`; whether the deployment's programmes use different
statements for outcomes than the fixed words in `STATEMENT`; and the
reading-grade target itself.

## cap-05 · Restoration and harm · 10 September 2026

**What is computed, and on what.** When a `bind` lapses — its premises
withdrew their own support — the reversal event carries `harm{}`: the days
the refusal stood (`days_without_coverage`, floor of whole days from
`sealed_at` to the lapse, timed by the database), and the days the
programme's rule restores (`days_owed`: the same, capped by the programme's
window). `harmOf()` is pure; fixed dates in, fixed numbers out, unit-tested
on SNAP (400 → 365), Medicaid (400 → 400), inside-window, floors, negatives,
and an unconfigured programme.

**Days, never dollars.** Crimp holds no benefit amounts and does not compute
them. A ledger of days is what the record supports; a dollar figure is the
programme's to attach from its own systems. `restoration.config.ts`: SNAP 12
months (7 CFR 273.17(a)), Medicaid to the action date (42 CFR 431.246 — no
window; 435.915 retroactive eligibility is a different provision and is not
modelled), prior authorization to the action date (42 CFR 438.424(a)). Each
`TODO(legal-confirm)`.

**Only a void refusal.** Not an expiry (ran out on its own terms), not a
taint (ground lost, not disproved), not a claw (a person overruled it and
owns that judgement), not a lapsed `permit` or `commit` (a grant withdrawn is
a loss, but the restoration rules cited do not speak to it). Each exclusion
is a test. The brief's "void" is this codebase's `lapsed`.

**Stated honestly.** The record cannot tell a correction of an error from a
change in the world — both look like a fact moving — so harm is *how long
the refusal stood*, not a finding of fault. Whether it was wrongful is for
an adjudication (capability 6) or a person.

**The ledger is a query.** `GET /insight/harm?days=` totals reversals,
days without coverage and days owed by programme (first scope segment), rule
(registered id, else hash prefix) and month, over `lapsed` events carrying
`harm` — nothing is accumulated anywhere else, so the ledger cannot drift
from the events it is made of.

**Tests.** 379 → 393 (6 unit, 7 integration, 1 e2e). The integration tests
age a seal with the existing `ageSeal` helper and let the real sweep lapse
it, so the arithmetic is exercised on the path that will run in production.

**Second implementation / format.** `harm` lives in an event's `detail`,
which the format already carries opaquely; no verifier change. Documented
under events in `docs/spec/extensions.md` (Phase 2).

**Human to confirm.** The three windows and citations; whether the
deployment wants a claw (human overrule) to carry harm as well — it is a
one-line change and a policy question, not a technical one.

## cap-06 · Systemic-error propagation · 10 September 2026

**The fact family.** An adjudication is attested about the appellant, by the
hearing authority as a named source, as ordinary facts: `adjudication.ruling`
(reversed | affirmed | remanded), `.ruleset`, `.rule_id`, optional `.pattern`
(a fact the rule may not rest on), `.authority`, `.date`. Nothing about them
is special to the evaluator. `fair_hearing_90_day` (cap-03) is met by
`adjudication.ruling`, as promised there.

**What the sweep does with a reversal that names a rule.** It finds every
open determination made under that rule — by registered id through
`rule_ref`, **or by identical content** through `rule_hash` matching any
version of that id, which is what content-addressed versions (cap-08) were
for — narrowed to those whose `reasons` rest on `pattern` when one is named.
Each is marked due and `review_flagged_at`; each gets a `systemic_review`
event saying which ruling; one `systemic_review` finding names them all with
a count. Then the same pass re-examines them. A ruling propagates **once**
(`systemic_reviews`, unique on appellant + ruling time); a reversal naming no
rule is about one person and is recorded as dealt with.

**Design divergence, recorded.** The brief says to re-evaluate "with the
ruling attached as a fact". Not done, for two reasons stated in
`systemic.ts`: a fact is a claim by a source about a subject, and writing the
appellant's ruling onto other people's records would have the sweep attest
what nobody attested; and re-running an unchanged rule against unchanged
facts changes nothing. The review flag says the same thing without pretending
to be evidence. **No outcome changes.** A ruling that a rule is wrong does
not say what the right rule is — closing the version and committing a
successor is the operator's act (cap-08), re-determining each case is a
person's (cap-10). What this capability makes complete and visible is the
set of cases, which is the part a person cannot do by hand.

**Visible everywhere it stands.** `under_review` on every lookup
(additive), `review_flagged_at` on the record (SPEC §7.0e, additive, not
hashed), and a fixed sentence on the notice while the determination stands —
not once it has moved.

**Tests.** 393 → 399 (4 integration, 1 e2e, 1 unit): one overturn reaches
four of five determinations (three by id, one by content) and not the fifth;
states unchanged; finding lists ids and count; second pass silent; pattern
excludes the determination refused on a different fact; a rule-less reversal
propagates nothing; lookup, proof, notice and the sweep's own result all
show it.

**Human to confirm.** Whether a closed catalogue should carry the
`adjudication.*` family by default (an operator must catalogue it before a
hearing authority can attest it); and whether `affirmed` rulings should be
recorded as a finding class of their own — they are evidence the rule
survived review, which is worth counting.

## cap-07 · Cross-programme reconciliation — ex parte first · 10 September 2026

**The brief's mechanism, and what it is in this codebase.** "Before a
procedural `no` in programme A can be recorded, evaluate whether any fact
held for programme B satisfies A's condition." The fact store here already
has no programmes: a subject's facts are one set, and a Medicaid rule reads
what SNAP's system attested without anyone reconciling anything. What was
missing was the ORDER the law states — 42 CFR 435.916(b)(1): try the merits
from what you hold before you ask the person for anything, and therefore
before you terminate them for not answering.

**What was built.**
- A ruleset may name its **ex parte rule** (`rulesets.ex_parte_rule`,
  `declareRuleset({ exParteRule })`, `POST /rulesets`): the committed rule
  that IS the programme's determination on the merits.
- A rule that rests on a `non_response` fact (cap-01's catalogue class) is a
  **procedural** determination. Before one may seal, the seal path resolves
  the ruleset's ex parte rule as of the decision date, loads every fact it
  names — from any source, any programme — applies the guards, and
  evaluates it. **Decidable (true or false): the procedural path is closed**
  — `cross_program_fact_available`, naming the rule, its outcome, and each
  fact with its source and the source's programme. Decide it on the merits.
  **Undecidable: the seal proceeds and the attempt is on its `sealed`
  event** — rule, version, outcome `unknown`, and which facts were missing.
  That record is the 435.916(b)(1) compliance evidence, per determination.
- A programme that declared an ex parte rule must keep one in force
  (`ex_parte_rule_not_in_force`); one that has not declared any is not
  blocked, and the event says `not_declared`.
- **A procedural determination must be committed policy**
  (`procedural_needs_registry`): an inline rule has no ruleset whose ex parte
  rule could be tried, so allowing it would make the protection optional by
  omission. This tightens cap-01, whose tests sealed procedural rules inline;
  they now seal by reference, and the change is recorded there and here.
- **Sources gained an API** (`POST /sources`, `GET /sources`;
  `src/domain/sources.ts`). Until now sources were rows a setup script
  inserted. A source now carries `programme` — the answer to "which programme
  did this fact come from" lives on the feed the institution declared, where
  it belongs. A source's admissibility class is fixed once declared, for the
  same reason attestations denormalise it: a live change would make the next
  fact from a feed weigh differently from the last with no event to say so.

**Tests.** 399 → 407 (8 integration): SNAP's income fact decides Medicaid's
substantive rule and the procedural termination is refused naming
`household.income` / `snap_case` / `snap`; undecidable proceeds with the
attempt recorded; blocked whichever way the merits come out; inline
procedural refused; closed ex parte rule refused; undeclared ex parte rule
proceeds and says so; a substantive rule is untouched; sources are an
operator act with a fixed class and a correctable programme.

**Second implementation / format.** The ex parte attempt lives in the
`sealed` event's `detail`, opaque to the format; no verifier change.

**Human to confirm.** Whether a programme's ex parte rule should be REQUIRED
rather than optional before any procedural rule may be committed under it
(one line in `commitRule`; a policy question); and the reading of
435.916(b)(1) that "decidable either way" closes the procedural path — a
substantive denial from facts on file is still a decision on the merits, and
that is the reading taken here.

## cap-09 · Drift and outage detection · 10 September 2026

**What had to exist first.** Two of the three outcomes left no trace: a rule
that did not hold created no seal, and a rule that could not be answered
raised an error. A monitor cannot count what was never written down. So
every evaluation now leaves one row in `evaluation_log` — workspace, rule
key, outcome (`yes` / `no` / `unknown`), reason code — **and nothing else**:
no subject, no facts, no values. The test asserts the table has no column a
subject could go in. Written after the transaction settles, so a refusal that
rolled everything back is still counted as the `unknown` it was; a replay is
not an evaluation and is not counted.

**The measure, as the brief specifies it.** Per rule and metric — the rate
of `unknown`, of `no`, and of each refusal reason — 14 days of daily rates
give a mean and a sample standard deviation; the 24-hour window drifts if
its rate exceeds the **lower** of mean + 3σ and 2 × mean. Two floors the
brief does not state and a zero baseline makes necessary, declared in
`DRIFT` and reported here: at least **20 evaluations** in the window (fewer
is anecdote, not a rate), a move of at least **0.05** absolute (a rule that
had never returned unknown and returns one today has had a Tuesday, not a
drift), and at least **3 baseline days**. Engineering parameters, not legal
ones.

**A finding, never an outcome.** Class `drift`, subject kind `rule`, detail
carrying baseline, current and threshold. One per rule, metric and window.
Nothing in the seal path reads this module. The sweep runs the check for
workspaces that evaluated anything in the window, at most once an hour each.

**Tests.** 407 → 412 (5 integration, synthetic streams with controlled
timestamps): a feed outage taking unknown from 3.3% to 83% is detected in
one window on both the outcome and the reason, with the exact threshold; a
day like every other is not drift; a small move, a thin window and a short
baseline are not drift; recorded once and reachable from the sweep; the seal
path writes yes / no / unknown-with-reason and nothing about the person.

**One expectation of mine the test corrected.** With a perfectly steady
baseline, mean + 3σ *is* the mean, so "whichever is lower" makes the
threshold strict — which is why `minDelta` exists and is stated.

**Human to confirm.** The three floors; whether `no`-rate drift should be
reported at all for rules where a rising refusal rate is the intended effect
of a policy change (the finding will fire on the day the change lands, which
is arguably the point).

## cap-10 · Human decisions through the same gate · 10 September 2026

**What a caseworker's decision is.** `POST /decisions` (`decide()`,
`src/domain/decisions.ts`; CLI `scripts/decide.ts`): a committed rule by
`ruleset` + `rule_id`, and facts, each with a source. That is the whole body.
The facts are attested under the caseworker's credential (`attester` = key
id, cap-01), the rule is resolved as of the decision date (cap-08), the
evaluator says what follows, and the seal, reasons, remedy, notice and
record are exactly what an agent's decision produces. A person, not an
agent: operator authority or above.

**No outcome field, by shape.** The schema has no `outcome`, `decision`,
`rule` or `disposition`, and `additionalProperties: false` makes each a
400, not an ignored key — tested for all four. A fact without a source is a
400 at the schema and `unknown_source` in the domain.

**The one thing the human path needed that the agent path did not.**
Disposition. An agent chooses `bind` / `permit` / `commit` per seal — the
*kind* of determination, not its outcome. At a keyboard that choice is an
outcome field wearing a hat. So a registered rule may now carry its
**disposition** (`rules.disposition`, migration 018; `commitRule({
disposition })`); set, it binds every seal made under the rule, agent or
person (`disposition_fixed_by_rule`), and the human path *requires* it
(`rule_has_no_disposition`). A caseworker who wants to decide something the
committed policy does not express commits the policy first, on the record.

**Default claw.** A person sealed it, so only a higher person may overrule:
`principal`, on `internal` evidence, no cooling-off — an operational default,
not a legal parameter; any tighter rule may be passed.

**Tests.** 412 → 419 (6 integration, 1 e2e): attester on the facts and on
the record; the evaluator still decides (`not_applicable` when the facts do
not satisfy the rule); agents refused; a rule without disposition refused;
an uncommitted rule refused; an undeclared source refused; a rule's
disposition binds the agent path too; every outcome-shaped field refused by
the schema.

**Human to confirm.** The default claw; whether the CLI should be shipped at
all or replaced by the deployment's own case-management integration.
