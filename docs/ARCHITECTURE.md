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
| `subject_events`, `alias_carve_outs` | Merges, refused merges, and the carve-outs that correct them |
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

## Who is this? — resolution, and the union it must not perform

One rule, and it is the one the subject graph is shaped around:

> **A write resolves identity from merge-capable aliases alone. A read looks at
> everything.**

A weak alias — a device, an IP, a household — must be able to *carry* a
determination, or a refusal is escaped by presenting a different phone. It must
never be able to *create* one, or presenting your own card alongside a shared
tablet unions you with whoever else uses it. Those are different questions and
they get different code paths: `resolveForWrite` and `resolveForRead` in
`src/domain/subject.ts`.

Aliases still attach freely on a write, and `ON CONFLICT DO NOTHING` is what
keeps that safe: an alias already bound to somebody stays bound to them. The
shared tablet does not move, so its owner is not dragged along.

| | Decides identity | Attaches | May cause a union |
|---|---|---|---|
| `strong` — card fingerprint, government id | yes | yes | yes |
| `medium` — email, phone | only if the workspace lowers `merge_threshold` | yes | only then |
| `weak` — device, IP, household | never | yes, if free | **never, at any setting** |

When a write finds several subjects it refuses with `merge_required` and names
the endpoint. It does not guess, and it does not union implicitly.

## Merge, and the carve-out that corrects it

`POST /v1/subjects/merge` is the most dangerous operation in the system: a union
is monotone, so a wrong one is permanent. Four bounds, none of them a policy
document:

1. **Every** subject drawn in must be reached by a merge-capable alias — not
   just "the presentation contains one somewhere".
2. At most `MAX_SUBJECTS_PER_MERGE` subjects, and at most
   `MAX_ALIASES_PER_SUBJECT` in the union.
3. `principal` authority *and* evidence dominating `internal`. An agent's own
   word — `self`, `signed` — can never union two people.
4. A standing carve-out blocks the merge that would walk around it.

The body takes aliases and never subject ids: a caller that could name the
subjects could union two it never demonstrated any connection to.

**A refused merge is recorded, on its own connection.** The refusal is written
outside the transaction that then rolls back, because otherwise "we record
refusals" is a comment rather than a fact. A workspace being probed for
poisonable subjects is visible precisely in the attempts that failed.

`POST /v1/subjects/carve-out` is the only correction, and it is deliberately
weaker than an undo — see ASSURANCE_CASE.md §4 for exactly how weak.

## Why, on the record — and who asked

A determination that cannot say why is not usable by the buyers this is for.
ECOA/Regulation B requires the specific principal reasons for an adverse
action; CFPB Circular 2022-03 is explicit that a complex algorithm does not
excuse a creditor from giving them. Crimp holds the rule that was applied, so
it is the only party that can derive the reason mechanically rather than
reconstruct it afterwards.

**Reasons are structured, never prose.** A path, a fact name, an operator, a
literal, the truth it carried, and its polarity. `src/domain/explain.ts`
follows Kleene directly — a conjunction that failed is explained by its false
children, a disjunction that held by its true ones — and two properties keep it
honest:

- **SUFFICIENCY** — restricting the facts to those the reasons name gives the
  same answer. Catches under-reporting.
- **ACCURACY** — every reason carries the outcome it is offered for, or its
  negation under an odd number of `not`s. Catches over-reporting, which
  SUFFICIENCY structurally cannot: telling somebody they were refused because
  of a condition they satisfied is the inaccurate-reason violation itself.

**Two fidelities, and the split is the security design.** A reason naming the
clause leaks nothing — the caller submitted the rule. A reason carrying the
observed value discloses what the institution holds about a person *and*
collapses threshold discovery from a binary search over repeated
attest-and-seal cycles into one call. That is the structuring vector Ratchet
exists to detect. A creditor must nonetheless give the reason, so the answer is
neither to refuse it nor to hand it out:

| | `POST /v1/seals` and `GET /v1/seals/:id` | `POST /v1/seals/:id/disclosure` |
|---|---|---|
| Clause, operator, literal, polarity | yes | yes |
| Observed value, source, admissibility | no | yes |
| The value that would have passed | no | yes |
| Authority | `seals:read` | `seals:disclose` **and** operator |
| Recorded as an event | no | **yes** |

Nobody anywhere currently records who asked why a person was refused. For a
regulated buyer that record is itself the compliance artifact, and
`GET /v1/insight/disclosures` is the log. It is deliberately **not** pressure:
asking why is not resisting, and counting it as contestation would corrupt the
quadrant.

## The proof

`GET /v1/seals/:id` returns what an examiner needs and nothing that identifies
a person: the rule as written, its canonical hash, the grammar version, the
reason set, every event, and for each fact the seal read its name, type,
source, admissibility, assertion time and `sha256(canonicalize({t, v}))` of the
value. **Not the value** — Crimp never held it. There is no subject id either;
a proof is about a determination, not a person.

The artifact carries its own verification instructions, because a proof that
does not say how to check it will not be checked, and documentation explaining
it may not still be hosted in 2032.

## Three fields the contract requires, and why

| Field | Required | Because |
|---|---|---|
| `idempotency_key` | yes | A retried POST must replay its determination, not create a second. For a `permit` with `max_uses: 1` that is the difference between one grant and two. Enforced by a unique index on `(workspace_id, idempotency_key)`, never by application logic. Reusing a key for a *different* rule is a 409, not a silent replay. |
| `grammar_version` | recorded | Stamped on every seal. The reproducibility claim is "re-run the sealed rule and get the same answer", and that is unprovable unless the seal says which semantics produced it. |
| `expires_at` | optional | Null means it stands until something ends it. A value already in the past is refused at seal time: it would bind nothing while reporting itself sealed. |

## Cohorts: a table with no read path

`subject_cohorts` exists so a workspace can ask *whose* errors go uncorrected —
83.2% of appealed Medicare Advantage denials were overturned in 2022 and only
about 10% of denials were appealed (KFF analysis of CMS data). The ~90% who
never appealed are not a random draw. That measurement is also the one thing here that could
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
