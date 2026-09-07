<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Architecture

The high-level design, and what it deliberately is not.

## The one inversion everything follows from

An agent does not tell Crimp what it decided. **There is no field for that.**

It submits the **rule** it is applying and references to **attested facts**.
Crimp evaluates the rule and derives the disposition. `SealInput` has no
`sealedBy`, `claw` has no `actor`, and neither has a `workspaceId` — all three
come from the verified credential, because an authority a request can assert is
not an authority.

```
agent  ──▶  { rule, facts }              submitted
Crimp  ──▶  evaluate(rule, facts)        derived
       ──▶  bind | permit | commit       recorded
```

Three consequences, and they are the product:

**Decisions become reproducible.** Re-run the sealed rule against the sealed
fact digests years later and get the same answer. The non-determinism did not
vanish; it moved out of the *decision* and into the *proposal*, where it is
harmless. The model authored the rule; the rule made the call.

**A hijacked agent cannot manufacture a determination.** It can propose a bad
rule, and a bad rule is visible, reviewable and reproducible in a way a bad
conclusion never is. Policy can require a rule to reference declared fact
classes, so a vacuous rule is a `400` rather than a clever attack.

**A decision can withdraw its own support.** Re-evaluate later against current
attestations: if the rule no longer holds the seal **lapses**, with no authority
involved and nobody having won an argument.

## Components

```
src/
  domain/            business logic; no HTTP types cross into here
    rule.ts            THE GRAMMAR. Validation, canonical form, introspection.
    evaluate.ts        Three-valued Kleene evaluation. Total, no clock.
    seal.ts            seal / lookup / exercise / claw / re-evaluate
    attest.ts          the customer pushes facts; Crimp never fetches
    lifecycle.ts       classify(), pressure tiers, hardening + its safety valve
    authority.ts       the total order, claw-rule validation, tighten-only
    admissibility.ts   the PARTIAL order over evidence classes
    scope.ts           containment; a tree today, a DAG later
    insight.ts         the three measurements — what the rest exists to enable
    auth.ts            keys, scopes, and where authority actually comes from
  api/
    app.ts             app factory: headers, CORS, rate limit, error shape
    schemas.ts         route schemas ARE the contract
    serialize.ts       the ONLY snake_case ↔ camelCase conversion
    routes/
  db/                  pool, migrations, migration runner
  lib/                 config · errors · ids · blind
```

## Data model

| Table | Holds |
|---|---|
| `subjects`, `subject_aliases` | Who a determination is about — as blinded, typed aliases |
| `fact_sources`, `alias_types` | What a workspace has declared it will trust, and how much |
| `attestations` | The **current** value of a fact. Operational state, deletable |
| `seals` | The determination: rule as written, canonical rule hash, claw rule |
| `seal_facts` | What it rested on — **digest only**, plus source and admissibility |
| `seal_events` | Append-only history. Clawing records, never deletes |
| `pressure` | Refused attempts, per seal, per declared session |
| `api_keys`, `key_events` | Credentials and every mint and revoke |

## Three values, not two

An unattested fact yields `UNKNOWN`, never `false`. A rule that reads it has
not been satisfied and has not been violated — it has not been answered.

That single decision produces the whole lifecycle for free:

| Re-evaluation | State | Meaning |
|---|---|---|
| still `TRUE` | `sealed` | nothing happened |
| now `FALSE` | **`lapsed`** | reality withdrew its own support |
| now `UNKNOWN` | **`tainted`** | ground gone, claim not disproved — still binding, surfaced, never auto-lifted |
| authority acted | `clawed` | a person overruled it, on the record |

`lapsed` is the unbiased correction channel: the institution discovering it was
wrong about somebody who never said a word. Every other measurement of wrongful
denial is computed only on the population that fought back.

There is no `unless` mechanism separate from the rule. The rule *is* the
falsification condition — re-evaluating it is what produces a lapse.

## Two orders, and the difference matters

**Authority is total.** `agent < operator < principal < custodian`. It describes
who overrules whom, which is hierarchical by construction; leaving that
undefined at the moment two authorities disagree is the one place a partial
order is unaffordable.

**Admissibility is partial.** It describes *kinds of evidence*, which are
frequently incomparable — `internal` and `witness` are deliberately unordered,
because an operator's ledger and an outside observer are wrong in different
directions. The consequence that matters falls out of the order rather than
being special-cased: neither `self` nor `signed` dominates `receipt`, so a claw
demanding disinterested evidence **cannot be satisfied by the party the
determination is against talking about itself.**

## Reporting, not authorising

`lookup` answers *what has been determined about this subject in this scope*. It
returns the determinations that stand and nothing else — no verdict, no boolean,
no token.

An earlier design returned `{ bound: true|false }` plus a scoped artifact for a
downstream gate to require. That described a system Crimp is not: it holds no
credentials, has no outbound access and executes nothing, so *"you may not
proceed"* is a claim it is not entitled to make. It also described, fairly
precisely, the pre-action authorization category that OPA, Cedar, the OAP draft
and at least one granted patent already occupy.

What Crimp has that none of them do is the determination itself. They evaluate
policy written in advance; none has a runtime determination to evaluate against.
Reporting rather than gating is both the honest description and the one that
makes Crimp compose with those systems instead of duplicating them.

`exercise` is separate because spending a permit is a mutation. Asking a
question must never cost you the answer — an earlier version consumed a use on
every check, so finding out whether a one-time grant was available destroyed it.

## Trust boundaries

```
   agent ──key──▶ │ Crimp │ ◀──attestations── customer's systems
                  │       │
                  └───────┘  no outbound access, no vendor credentials
```

- **Crimp never fetches.** The customer pushes. Nothing here can reach into a
  customer system, which is what a compromise of Crimp cannot become.
- **Crimp never performs an action.** Same boundary as Ratchet, same reason.
- **Crimp never sees a subject.** Aliases are `HMAC(pepper, workspace|type|value)`
  truncated to 128 bits, with the workspace id inside the MAC so the same card
  number in two workspaces is uncorrelatable.
- **The cost, stated rather than engineered around:** the customer is the trust
  root for its own facts. See the assurance case.

## Concurrency

- **At-most-N on a permit is enforced by the database**, not application logic:
  `UPDATE … WHERE uses < max_uses` returning zero rows *is* the refusal. Eight
  concurrent callers against a one-use permit produce exactly one winner, and a
  test asserts it.
- **Claw takes `FOR UPDATE` on the seal row** before reading its claw rule, so
  two reversals cannot both pass the authority check.
- **Re-evaluation is compare-and-set**: `UPDATE … WHERE state = $expected`. If
  somebody clawed it first, their record wins and the sweep moves on.

## Deployment

- **Control plane**: stateless. Any container platform.
- **Database**: Postgres. Not negotiable — the design depends on `FOR UPDATE`,
  partial indexes and advisory locks. SQLite cannot express them.
- Migrations run on boot behind a transaction-scoped advisory lock, so several
  instances may start at once.
- There is no worker yet. Re-evaluation is a function, not a loop; when it
  becomes a loop it must be long-running, and that constraint will land here.
