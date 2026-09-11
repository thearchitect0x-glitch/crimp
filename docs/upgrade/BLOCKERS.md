<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Upgrade blockers — decisions that need a human

The brief says: stop and write a blocker note rather than guess when a design
question cannot be resolved from the code and the spec. These are those.

## B1 · Retroactive rule substitution on re-evaluation (cap 8)

**The brief asks:** "Re-evaluation uses the decision-date version unless the
law itself is retroactive (config flag)."

**What the code does today:** re-evaluation re-runs the rule *as sealed*, which
is the decision-date version, because the seal stores the rule inline. That is
the default the brief wants, and it needs no flag.

**Why the retroactive case is not implemented:** substituting a successor rule
at re-evaluation changes the rule that governs the determination, and therefore
`rule_hash`. `rule_hash` is what SPEC §8 step 3 verifies. A record whose
governing rule differs from its sealed rule either fails verification or needs
a *second* rule and hash alongside the first — "sealed under" and "now governed
by" as distinct fields — and every verifier, both implementations, and the
conformance vectors would need to understand which one to re-run and when.

That is a format decision, and a consequential one: it is the only place in
the design where a determination's meaning is allowed to change after the fact
without a human act. I am not making it unilaterally.

**What is needed from a human:**
1. Confirm whether retroactive application is required for any target
   programme in the first deployment. If not, this stays deferred.
2. If yes: decide between (a) a second `governing_rule` + `governing_hash` on
   the record, with re-evaluation under the governing rule and the proof
   verifying both, or (b) treating a retroactive law change as an *authority
   act* — a human commits the successor and explicitly re-seals affected
   determinations, so the change is on the record as somebody's decision rather
   than a sweep's.
3. I recommend (b). It keeps "no determination changes meaning without a
   human act" intact, it is already expressible with `commitRule` + a re-seal,
   and it produces the audit trail a regulator would ask for.

**What is recorded meanwhile:** nothing. No `retroactive` column, because a
column nothing acts on is the pattern this codebase has found five times and
each time it was a defect wearing the clothes of a feature.

## B2 · Advance notice as a constraint on WHEN a refusal takes effect (cap 3)

**The brief lists** `advance_notice_10_day` among the clocks. 42 CFR 431.211
requires the notice to be mailed at least 10 days *before* the date of
action. That is not a deadline the agency must meet; it is a **minimum
interval** between two events — notice, then effect — and "missed" means the
action took effect too soon.

**Why it is not a clock in cap-03:** nothing on the record marks "the action
took effect". A `bind` is visible to lookups the moment it is sealed. To
model advance notice honestly the record needs an *effective date* on a
refusal — the door analogy's "touch the when" — and lookups would then return
a sealed-but-not-yet-effective determination differently. That changes the
hot path and the format (§7 would gain `effective_at`), and it is in the
person's favour, but it is a behaviour decision, not a finding.

**What is needed from a human:** decide whether a `bind` may carry an
`effective_at` no earlier than `sealed_at + advance-notice interval` (config,
`TODO(legal-confirm)`, default 10 days; 5 for the exceptions in
431.213/431.214), with `lookup` reporting `pending_effect` until then. If yes,
`advance_notice_10_day` becomes a constraint the seal path enforces rather
than a clock the sweep watches — which is the stronger form.

**Recorded meanwhile:** nothing. No config entry, because a definition
nothing starts is a dead entry.

## B3 · Arithmetic in the grammar (found by the SNAP configuration)

**What the configuration found:** SNAP's net income test (gross less the
7 CFR 273.9(d) deductions), expedited criterion (iii) (income plus liquid
resources against shelter costs) and age from a date of birth are
arithmetic, and the grammar has none — no operators, no fact-to-fact
comparison — by design. Each arrives as a *derived fact* the state's
benefit engine computed. The record commits to the derived value's digest
and not to its derivation, so an examiner verifies the test and takes the
arithmetic on the attester's word. For net income, that is where SNAP's
payment errors live.

**Two options, with their costs:**

1. **Bounded arithmetic in the format.** Linear expressions over facts with
   literal coefficients, and fact-to-fact comparison, as new node kinds.
   A §9 widening: every implementation carries it forever, the constant-
   conclusion check and the remedy's cell partition must be extended to
   it, and the conformance suite grows. In return the deductions are in the
   record and re-runnable.
2. **Name the deriving engine.** A catalogue attribute on a derived fact —
   `derived_by: "<engine> <version>"` — carried onto the attestation and
   the record's `facts[]`, so the record says *which* computation produced
   the value even if not *how*. No format change beyond one optional
   field; the engine's own audit is where the arithmetic is checked.

**Recommended:** 2 first. It is a catalogue attribute and an optional
record field, it names the accountable component, and it keeps the
grammar a grammar. Revisit 1 only if a buyer's auditors require the
deductions to be re-runnable from the record itself — and then as a 0.3
format decision, not a patch.

## B4 · Actionability in the remedy (found by the SNAP configuration)

**What the configuration found:** the remedy for a gross-income denial
correctly lists a larger household as a way out, and the notice prints
*"Number of people in the SNAP household is at least 5."* Mathematically
true; not advice. The remedy has no notion of which facts a person can
change.

**Proposal:** a `mutability` attribute on catalogued facts —
`actionable` (income, a verification, a returned form), `circumstantial`
(household size, age — they change, but not on request), `fixed`
(identity). The *record* is unchanged: the remedy stays exact and
complete. The *notice* orders remedies by mutability and prints the
circumstantial ones, if at all, under a separate heading. The FHIR process
note follows the notice.

**Decision needed:** whether the notice should omit circumstantial
remedies or show them under a heading; and the default mutability of an
uncatalogued fact (recommended: `actionable`, so nothing is hidden by
omission).
