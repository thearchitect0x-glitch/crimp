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
| `cohort_types`, `subject_cohorts` | Blinded cohort membership. **Write-only** — see below |
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
| grammar unsupported | **`tainted`** | this build cannot reproduce the semantics it was sealed under, so it does not re-decide |
| past `expires_at` | **`expired`** | it ran out. Checked *before* the rule, so a lapse is never invented after the fact |
| authority acted | `clawed` | a person overruled it, on the record |

`expired` is deliberately not `lapsed`. Lapsed means the institution was wrong;
expired means the determination simply ended. Collapsing them would count every
expiry as an error and corrupt the quadrant, which is the measurement the
product exists for.

`lapsed` is the unbiased correction channel: the institution discovering it was
wrong about somebody who never said a word. Every other measurement of wrongful
denial is computed only on the population that fought back.

There is no `unless` mechanism separate from the rule. The rule *is* the
falsification condition — re-evaluating it is what produces a lapse.

## Three fields the contract requires, and why

| Field | Required | Because |
|---|---|---|
| `idempotency_key` | yes | A retried POST must replay its determination, not create a second. For a `permit` with `max_uses: 1` that is the difference between one grant and two. Enforced by a unique index on `(workspace_id, idempotency_key)`, never by application logic. Reusing a key for a *different* rule is a 409, not a silent replay. |
| `grammar_version` | recorded | Stamped on every seal. The reproducibility claim is "re-run the sealed rule and get the same answer", and that is unprovable unless the seal says which semantics produced it. |
| `expires_at` | optional | Null means it stands until something ends it. A value already in the past is refused at seal time: it would bind nothing while reporting itself sealed. |

## Cohorts: a table with no read path

`subject_cohorts` exists so a workspace can ask *whose* errors go uncorrected —
80.7% of appealed denials are overturned and 6.2% are appealed, and the 6.2%
are not a random draw. That measurement is also the one thing here that could
be turned into a discrimination tool, so the constraints are structural rather
than procedural:

- Membership is blinded like an alias, under a different domain prefix, so a
  band can never be presented as an alias.
- **There is no per-subject cohort read anywhere in this codebase.** Not gated,
  not permissioned — not implemented. Nothing to abuse and nothing to subpoena.
- A declared cohort may not be attested as a fact, and an attested fact name
  may not be declared a cohort. A cohort therefore cannot reach the grammar and
  cannot appear in a rule.
- `cohorts:write` is deliberately absent from `AGENT_SCOPES`.
- Erasure takes cohort membership with it — a row with no read path is exactly
  the row an erasure quietly leaves behind.

The aggregate query is not built yet. When it is, it returns null below a
k-anonymity floor, the same discipline as every other measurement here.

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
