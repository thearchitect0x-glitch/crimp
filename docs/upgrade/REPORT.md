<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Upgrade report

**Branch:** `upgrade/phase-0`, 14 commits off `integration-check` (73e1dc2),
which is the nine open PRs merged. It must land *after* them, in the order
`MERGE-ORDER.md` gives, and #18 only after the provisional is filed.

**Measured, at the last commit (61f6001):**

| | Before (73e1dc2) | After (61f6001) |
|---|---|---|
| Tests (`npm test`: typecheck + unit + integration + e2e) | 287 pass | **432 pass**, 0 fail |
| Conformance vectors, reference implementation | 32 | **60** |
| Conformance vectors, independent verifier | 24 | **37** |
| Fuzz properties (`npm run fuzz`, 2 000 runs) | 19 | **23** |
| Coverage (c8, `src/**`, all three suites) | — | 96.8 % statements · 89.6 % branches · 96.0 % functions |
| `npm run audit` | clean | clean |
| Files changed | | 80 (+9 758 / −73) |

Every number above is quoted from the tool that printed it, not from memory.

---

## 1 · What was implemented

All ten capabilities, in the dependency order the capability map gave
(8 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 9 → 10), then Phase 2. One commit each,
named `cap-NN:`; each with its spec section where the format was touched,
tests at the right layer, a second-implementation note, and a changelog
entry. `00-capability-map.md` carries the before/after status per row;
`CHANGELOG.md` carries the detail. In one paragraph each:

- **cap-08 · Rule registry.** Rulesets; rules with `legal_authority`,
  `effective_from/to`, and **version = canonical-form hash** — immutable by
  construction, and two institutions committing the same policy share a
  version. One version in force per instant by database exclusion
  constraint. The seal keeps its rule inline; `rule_ref` and `as_of` are
  additive record fields (§7.0a). Retroactive substitution → blocker B1.
- **cap-01 · Delivery before non-response.** Not a word list: a **fact
  catalogue** where a `non_response` fact cannot exist without naming the
  `delivery` fact that guards it, and a closed catalogue in which a synonym
  is not detected but impossible. A guarded fact is withheld before
  evaluation; the evaluator is unchanged and Kleene monotonicity keeps the
  record reproducible (§7.0c). Attester recorded on every fact (§7.0b).
  **F1 closed:** constant conclusions refused at admission (§3.x), and a
  pre-existing grammar/evaluator disagreement (boolean set members) found
  and fixed by the new vectors.
- **cap-02 · Remedy.** Every minimal correction set, exact per cell
  (reusing the F1 partition), bounded at 65 536 evaluations and saying
  whether it was exhaustive; value-free with respect to the person; stored
  with the seal (§7.0d); the independent verifier checks each set is
  *effective*.
- **cap-03 · Clocks and findings.** Seven federal deadline clocks in config,
  started from an attested event, met by the record, missed by the
  database's calendar; a missed clock is an `agency_timeliness` finding
  and never an outcome — there is no code path from clocks to a seal's
  state, which is why a clock is not a rule-readable fact. Findings table
  shared with caps 6 and 9. Timeliness insight. Advance notice → B2.
- **cap-04 · Notice as derivation.** A pure function of the record —
  outcome, cited rule, deciding clauses, facts, remedy, clocks, configured
  appeal rights — rendered to text and HTML byte-identically; no generated
  prose (fixed operator table, complement operators for negation, cited
  config); values only through the recorded disclosure gate; reading grade
  reported against 8, never enforced; translation as an interface only.
- **cap-05 · Harm.** On a lapsed `bind`, the reversal event carries days
  without coverage and days owed under the programme's restoration window
  — days, never dollars — computed by pure arithmetic on fixed dates; never
  for an expiry, taint, claw, permit or commit. Ledger is a query over the
  events.
- **cap-06 · Systemic review.** An adjudication is ordinary attested facts
  about the appellant; a reversal naming a rule reaches every open
  determination under it — by registered id **or identical content**,
  narrowed by fact pattern — flags each, marks it due, records the ruling
  on it, and raises one finding naming them all. Once per ruling. No
  outcome changes; visible on lookup, record (§7.0e) and notice.
- **cap-07 · Ex parte first.** A ruleset names the committed rule that *is*
  its determination on the merits. A procedural rule (one resting on a
  `non_response` fact) may not seal while that rule is decidable from any
  fact on file, from any programme; when it is not decidable, the attempt
  is recorded on the seal — the 42 CFR 435.916(b)(1) evidence. Procedural
  determinations must be committed policy. Sources gained an API and a
  `programme`.
- **cap-09 · Drift.** Every evaluation logged, subject-free; per rule and
  metric, 14-day baseline, 24-hour window, lower of mean + 3σ and 2×, with
  three stated floors; a finding, once per window, checked at most hourly.
- **cap-10 · Human decisions.** `POST /decisions`: a committed rule and
  facts, nothing else — no outcome field by schema; facts attested under
  the caseworker's credential; a registered rule may carry its
  `disposition`, which binds every seal under it and which the human path
  requires. CLI `scripts/decide.ts`.
- **Phase 2.** Ed25519 **signatures** over the sealed core (§7.0f) under a
  published key, required in production; `spec/verify-cli.mjs`, dependency
  free, offline, exit-code honest. **FHIR** projection (`ClaimResponse`,
  `Task`, `Bundle`) for CMS-0057-F with a byte-asserted fixture.
  `docs/spec/extensions.md`, prepared and not published. The **person's
  copy**: facts with values, signed records, clocks, keys and the verifier
  inline — self-verifying, recorded as a disclosure.

---

## 2 · What was left as a blocker, and why

Both in `BLOCKERS.md`, each with what a human must decide and a
recommendation.

- **B1 · Retroactive rule substitution on re-evaluation (cap 8).**
  Substituting a successor rule changes `rule_hash`, which §8 step 3
  verifies; a record whose governing rule differs from its sealed rule
  needs a second rule and hash on the record and a verifier that knows
  which to re-run. That is a format decision and the only place the design
  would let a determination change meaning without a human act.
  Recommended: treat a retroactive change as an authority act — commit the
  successor, explicitly re-seal — which is already expressible. No dead
  config flag was added.
- **B2 · Advance notice as a constraint on *when* a refusal takes effect
  (cap 3).** 42 CFR 431.211 is a minimum interval between notice and
  effect, not a deadline, and nothing on the record marks "took effect".
  Modelling it honestly needs an `effective_at` on a refusal and a lookup
  that reports `pending_effect` — a behaviour and format decision in the
  person's favour. Not shipped as a clock nobody starts.

---

## 3 · Where I was tempted to add a conclusion channel or a model, and refused

Each of these was the shorter path. Each would have put a judgement where
the design keeps a derivation.

1. **A synonym list for "non-response" (cap 1).** The brief's wording
   invites a lexical match on fact names. A word list is a heuristic model
   of meaning and is beaten by the next name. Refused; the catalogue makes
   the synonym impossible instead of detected.
2. **Clock status as a rule-readable fact (cap 3).** "Clocks as facts"
   read literally would let a rule say `deny if clock = missed` — the
   agency's lateness deciding the person's outcome, which the brief
   forbids in the same sentence. Refused; a clock is a record-bound object
   with no path to evaluation.
3. **A generated sentence in the notice (cap 4).** The obvious way to make
   a reason readable. A sentence cannot be re-derived, so none appears:
   fixed operator phrases, the exact complement operator for negation,
   cited config for appeal rights, a label dictionary a translator may
   replace. The reading grade is reported (10.2 for the reference notice)
   rather than fixed by rewriting.
4. **Values in the notice without the disclosure gate (cap 4).** A notice
   with values is what a person needs and what an adversary probes for.
   Refused as a second door; `values: true` goes through `disclosure()`
   and is recorded.
5. **Choosing the "easiest" remedy, or naming a value to aim for
   (cap 2).** Both are judgements. The remedy reports every minimal set and
   the cell each fact must land in, and stops.
6. **Attaching the ruling as a fact to other people's records (cap 6).**
   The brief suggests it. The sweep would then be attesting what nobody
   attested, and re-running an unchanged rule against unchanged facts
   changes nothing. Refused; a review flag says the same thing without
   pretending to be evidence. Auto-tainting the affected determinations
   was also refused: a state change without a human act, and the next
   sweep would undo it.
7. **Letting an inline procedural rule skip the ex parte check (cap 7).**
   It would have kept cap-01's tests green and made the protection
   optional by omission. Refused; `procedural_needs_registry`, and the
   tests were moved onto committed rules.
8. **A `disposition` parameter on `/decisions` (cap 10).** At a keyboard
   the kind of determination is an outcome field wearing a hat. Refused;
   disposition is committed with the rule and binds the agent path too.
9. **A `retroactive` column nothing acts on (cap 8).** The pattern this
   codebase has now found six times. Refused; blocker B1 instead.
10. **Anomaly detection with anything smarter than the stated arithmetic
    (cap 9).** A plain threshold the brief specifies, with three stated
    floors, reported as a finding. Nothing learns.
11. **Fetching signing keys from a URL inside the record (Phase 2).** A
    verifier that did so would be asking the issuer to vouch for itself.
    Refused; keys are supplied by the verifier and kept.
12. **Summarising the person's copy (Phase 2).** Raw records, values, keys
    and the verifier; no narrative.

---

## 4 · What the tests found in my own work

Recorded because the brief's rules of engagement are about honesty, and
because these are the defects a future change is most likely to repeat.

- The citation grammar rejected `&` — every "Welf. & Inst. Code" citation
  (cap 8). An aborted-transaction diagnostic (cap 8). A seal's guard fact
  never loaded, because the delivery fact is by design not in the rule
  (cap 1). The remedy search stopped after the first witness per subset,
  missing a second cell for the same fact (cap 2). Two of my
  expectations were wrong about the search bound (cap 2). `wouldHaveNeeded`
  never appears for a clause that held (cap 4). A blank lead line (cap 4).
  The exclusion threshold under a steady baseline is the mean itself
  (cap 9). The sweep is global (cap 9). The verifier scored "no values
  supplied" as a failure (Phase 2 — pre-existing, exposed by the CLI).

---

## 5 · Decisions that need a human

**Legal parameters to confirm** — every one is in config with a
`TODO(legal-confirm)` and a federal default drawn from the rule it cites:

- `src/domain/clocks.config.ts` — seven intervals and citations
  (42 CFR 435.912(c)(3); 7 CFR 273.2(g)(1), (i)(3)(i); 42 CFR 438.210(d) as
  amended by CMS-0057-F, and its compliance date for the payer;
  42 CFR 431.244(f)(1)). State standards may be tighter.
- `src/domain/notice.config.ts` — appeal windows, continued-benefits
  windows, citations and the fixed appeal text for Medicaid, SNAP and prior
  authorization (42 CFR 431.221(d), 431.230; 7 CFR 273.15(g), (k);
  42 CFR 438.402(c)(2)(ii); Medicare Advantage differs).
- `src/domain/restoration.config.ts` — SNAP 12 months (7 CFR 273.17(a)),
  Medicaid to the action date (42 CFR 431.246), prior auth
  (42 CFR 438.424(a)).
- The citation grammar in `validateCitation` — it decides what a
  programme may cite.
- The reading of 42 CFR 435.916(b)(1) taken in cap 7: that a substantive
  denial from facts on file is still a decision on the merits, and closes
  the procedural path.

**Per-programme configuration a deployment must supply:** the fact
catalogue (which facts are non-response, which notice guards each, and
the `adjudication.*` family if a closed catalogue is used); rulesets, rules
with citations and dispositions, and each ruleset's ex parte rule; sources
with their programme.

**Thresholds and engineering choices, stated in code and here:** the
constant-conclusion bound (65 536); the remedy bound (65 536); drift floors
(20 evaluations, 0.05 delta, 3 baseline days) and cadence (hourly); the
reading-grade target (8); the default claw on a caseworker's decision
(`principal` / `internal` / no cooling-off).

**Policy questions raised in the changelog:** whether a claw (human
overrule) should carry harm; whether `affirmed` rulings should be a
finding class; whether an ex parte rule should be *required* before any
procedural rule may be committed; whether `no`-rate drift should fire on
the day a policy change lands; whether to ship `scripts/decide.ts` or
replace it with the deployment's case-management integration.

**Operational, before production:** generate `SIGNING_KEY` and escrow it
beside `BLIND_SECRET` (production refuses to start without it); apply the
payer's Da Vinci PAS/PDex profiles on top of the FHIR projection
(`TODO(interop-confirm)`); decide whether and when to publish
`docs/spec/extensions.md` — after the provisional, not before.

**Format decisions (B1, B2)** as above.

**Observed and left alone, for the record:** `Proof.verify` crosses the
wire with camelCase keys (`verify.ruleHash`), a pre-existing leak across
the serializer boundary; renaming is a wire-contract change and was out of
scope. `interop/fhir/` lives at `src/interop/fhir/` so the build config
covers it.

---

## 6 · Things the repository did better than the brief, kept

Recorded in the capability map as the brief asks:

- The fact store had no programmes to reconcile across — cap 7 became the
  ex parte *order*, which is what the law actually states.
- Kleene three-valued evaluation and the absent-is-UNKNOWN rule already
  gave cap 1's cases (b) and (c) for free once the guard withheld the fact;
  no evaluator change was needed for any capability.
- The correction channel's two triggers (change-driven and cursor-driven)
  already made cap 6's "enqueue for re-evaluation" a one-column update.
- Content-addressed rule versions (cap 8) gave cap 6's "same rule" match
  on inline rules with no extra design.
- The existing disclosure gate gave cap 4's two fidelities and Phase 2's
  person-copy recording with no new concept.
