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
