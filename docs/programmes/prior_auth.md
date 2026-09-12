<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Prior authorization as a Crimp programme — a worked configuration

The second programme, built the way the first was: not to demonstrate the
format but to find where it meets real policy and where it does not. SNAP
found four things. This one found three, and the first of them was fixed
in the same change.

`src/programmes/prior_auth.ts` is the configuration; `scripts/seed-prior-auth.ts`
applies it; `test/integration/prior_auth.test.ts` walks it end to end and
asserts each finding, so that fixing one is a visible act.

## What is in it

- **Eight sources**, each with its admissibility class and its programme:
  the utilization-management system and a physician reviewer (`internal`),
  the payer's own claims history (`internal`), the requesting provider on
  the portal (`signed`: non-repudiable, and interested), clinical records
  received from the EHR (`receipt`), the member (`self`), an independent
  review entity (`authority`), and the mail vendor (`receipt`).
- **Seventeen catalogued facts**, including a delivery-class fact for the
  request for additional information and a non-response fact guarded by
  it, so that a denial for want of information cannot rest on a request
  nobody received (cap-01, unchanged from SNAP).
- **One ruleset, six rules**, every criterion a literal with a citation:
  lumbar MRI authorised (a red flag, a neurological deficit, or six weeks
  each of conservative therapy and symptoms) and denied (none of those);
  duplicate imaging within twelve months; step therapy for a non-preferred
  drug; the procedural denial; and the expedited path, which the
  provider's attestation of jeopardy satisfies by regulation. Every
  citation is `TODO(legal-confirm)`: CMS-0057-F's compliance dates differ
  by payer type, Medicare Advantage and Medicaid managed care regulate the
  same act under different sections, and the clinical criteria are the
  plan's own, which 42 CFR 422.101(b)(6) requires to be publicly
  accessible.
- **Two clocks** already in `clocks.config.ts`: seven calendar days
  standard, seventy-two hours expedited, met by the determination.
- **Authorization units** as a permit with uses: twelve visits, and the
  thirteenth refused by the database, not by the application.

## Finding 1 — resistance arrives as an appeal (fixed)

In benefits, a person who is refused comes back and is refused again, and
the gate counts it as pressure. In prior authorization nobody comes back
that way. The member never looks up the determination; the provider's
portal session touches many members and is, correctly, excluded as wide
(breadth.ts). The quadrant, whose pressure axis is the whole point of the
"contested" cells, was blind to the one signal this domain has: the
reconsideration, the grievance, the external review request.

Fixed in `appeal.ts` and migration 025. An appeal is an event on the
refusal it contests, recorded by whoever received it (`POST
/v1/seals/:id/appeal`, channel and an opaque reference), and the quadrant
and the estimate count a determination with an appeal as contested. It is
not a ruling and changes no state; the ruling, when it comes, is the
adjudication family, and may reach every case under the rule. The test
records an appeal against a denial, watches the quadrant move it to
"contested and correct", then lets the EHR records arrive with the red
flag the request had not carried, and watches it move to "wrong and
resisted" at the write.

## Finding 2 — time as the only remedy

"Conservative therapy for at least six weeks" is a criterion a member can
satisfy only by waiting and being treated. The remedy names it, truthfully,
beside the red flag and the deficit that nobody can bring about. SNAP's
finding B4 asked for a mutability attribute with two kinds, mutable by the
person and fixed; this needs a third, **mutable by time**, so a notice can
say "this criterion will be met on [date] if therapy continues" rather than
listing it beside a fracture. Recorded against B4 in BLOCKERS.md; not built
here.

## Finding 3 — the derived facts, again

Weeks of conservative therapy and months since prior imaging are computed
by the payer's claims engine from paid claims. The record commits to the
numbers and says nothing about the computation. SNAP found the same for
net income and age (B3). Two programmes finding it independently makes it
a property of the format rather than of one configuration: a derived fact
needs derivation provenance (the engine, its version, its inputs' digests),
which the provisional specification describes and the product does not yet
carry.

## Not modelled, and why

- **Gold-carding** (a provider exempt from prior authorization by track
  record) is state law with no federal hook the citation grammar accepts;
  the fact is not even catalogued until a state is chosen.
- **Out-of-network denials**: the rules vary by plan type and by the
  member's circumstances in ways that would have needed invented
  citations. Better absent than wrong.
- **Peer-to-peer review** is catalogued as a fact and used by no rule: it
  is a procedural right, not a criterion.

## Before a deployment

Every `TODO(legal-confirm)` in the configuration, the two clocks, the
notice text and its 60-day window, and the restoration rule for prior
authorization, confirmed by a person against the payer's actual plan type
and its current criteria, and committed with a citation.
