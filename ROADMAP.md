<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Roadmap

What Crimp intends to do, and not do, over the next year. Written 6 September
2026 and reviewed when it stops being true rather than on a schedule.

Crimp is a decision gate: an agent submits the rule it is applying rather than
the outcome, and the system derives the outcome, seals the rule before the
result is known, and measures how often that rule turned out to be wrong.
Everything below is judged against whether it makes that measurement more
trustworthy.

## Now — shipped and tested

- The predicate grammar and its three-valued evaluator. Total, deterministic,
  no clock, no loops. Mutation-verified.
- Attestation with declared sources and an admissibility partial order.
- Blinded subject aliases with declared merge strength.
- The seal lifecycle: `seal`, `check`, `claw`, and re-evaluation producing
  `lapsed` or `tainted`.
- Pressure, and pressure-hardening with its safety valve.
- The three measurements: source reliability, the wrongful-denial quadrant,
  and threshold cliffs.
- API keys whose authority is a property of the credential, with an issuance
  ladder that governs itself.
- The HTTP surface, key-only, with schemas as the contract.

## Next — the next six months

**A measurement with a real design partner, first.** Nothing here is worth
building further until somebody's actual determinations produce a real
wrongful-denial number. If that number is small, the retail case dies and this
roadmap changes shape. Two weeks of one partner's data outranks every feature
below.

- **Subject merge.** Today Crimp refuses with `merge_required` when presented
  aliases already belong to several subjects, because a monotone merge is
  permanent and a wrong one drags strangers under somebody else's
  determination. The degree-bounded merge with authority-signed carve-outs is
  the largest remaining piece of engineering, and it should be designed against
  real customer data rather than guessed at.
- **The scope DAG.** Scopes are a tree today, so a seal on `money.out` does not
  catch a refund. A DAG is a superset, so every seal written under the tree
  stays valid — widening is safe, which is why this order.
- **MCP tools and a published OpenAPI document**, so an agent can discover the
  surface rather than be told about it.
- **Deployment.** There is none. When it exists, `BLIND_SECRET` must be in
  escrow before the first determination is sealed: a blinded alias cannot be
  re-derived, so losing that secret does not degrade the system, it orphans
  every determination in it permanently.
- **Signed releases**, and a documented way to verify one.
- **Re-rehearse continuity** once a production database exists. The 6 September
  rehearsal covered a system with no deployment; a rehearsal that covers less
  than the current system has stopped being a rehearsal.

- **Quorum on a merge.** A merge is permanent and unreviewable, which makes it
  a stronger candidate for dual control than a claw. `claw.quorum` exists; the
  merge path has no equivalent.

## Later — under consideration, not committed

- **A Merkle transparency log with external witnesses**, giving inclusion,
  consistency, antedating and absence proofs. The valuable part is proving that
  the *rule* predated the case, not that a record existed. Held back because a
  witness set you run yourself is not independent, and bootstrapping a credible
  one is a multi-party project with no engineering content.
- **Cross-organisation pressure pooling**, for agents rather than people —
  agents are not consumers, which is what keeps it out of FCRA territory. This
  is a legal and commercial project at least as much as an engineering one, and
  a shared negative file built carelessly causes real harm. The architecture
  must not preclude it; nothing more, for now.
- **`commit` at scale.** The disposition exists and is tested. What is missing
  is the ingestion path for what an agent told a customer, which is a different
  integration problem from the rest of the product.
- **The cohort aggregate.** The schema, the blinding, the write paths and the
  refusals are in. The query that answers "whose errors go uncorrected" is not,
  and it waits for a design partner who needs it — building the read path
  before somebody has a real question to ask it is how a measurement quietly
  becomes a targeting tool. When it lands it returns null below a k-anonymity
  floor, and it never answers about an individual.

## Explicitly not doing

These are decisions, not omissions. Each has been considered and declined.

- **Being a fairness arbiter.** Crimp reports counts. It does not opine on
  whether a rule is just, and it will not ship a feature that does. This is
  both the honest position and, given OMB M-26-04, the commercially survivable
  one.
- **Natural language on the decision path.** No model-generated explanation of
  why something is bound, ever. Reason codes only. The moment prose enters the
  decision, the property the product is sold on is gone.
- **Auto-resolving an unknown.** A rule that reads an unattested fact is
  `UNKNOWN` and the seal becomes `tainted`, not `lapsed`. Guessing is the one
  thing a gate must never do.
- **Storing the raw historical value of a fact.** Only the current attestation
  and a digest. Not negotiable — it is what makes erasure a `DELETE` rather
  than a crisis.
- **Holding customer credentials or reaching into customer systems.** The
  customer pushes; Crimp never fetches. This costs us the ability to verify
  what we are told, and that cost is stated in the assurance case rather than
  engineered around.
- **Crypto payments.** Stripe or nothing. Ratchet carries an x402 and
  multichain surface; Crimp will not.
- **A composite score.** No blended risk number, for the reason Ratchet's
  reliability reporting gives: a composite hides the mechanism and invites
  gaming by suppressing whichever signal drags it down.

## How this changes

By pull request, or by the maintainer when reality moves. If something here has
been "Next" for a year, it belongs in "Later" or in "Not doing", and moving it
is more honest than leaving it.
