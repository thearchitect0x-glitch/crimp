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
