<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# The Determination Format

**Version 0.1 · draft · 7 September 2026**

A determination is a record that a named rule was applied to named facts and
produced a stated outcome, sealed before the outcome was known, and re-runnable
by anyone holding the facts.

This document specifies the format and the verification procedure. It is
written so that a third party can implement a verifier **without access to any
Crimp source code**, and it is published for that purpose.

> **Status.** Deliberately published as prior art. Anyone may implement it,
> verify against it, or build on it. The format is not patented and will not be
> patented — a specification nobody may implement is not a specification.
> Corrections and competing implementations are the point.

---

## 1 · Why this exists as a separate document

An institution making an automated adverse decision is, in several
jurisdictions, already obliged to say why:

- **ECOA / Regulation B** requires the specific principal reasons for an
  adverse action. CFPB Circular 2022-03 states that a complex algorithm does
  not excuse a creditor from giving them.
- **CMS-0057-F** requires a specific denial reason on prior authorization.
- **Goldberg v. Kelly**, 397 U.S. 254 (1970), requires *"timely and adequate
  notice detailing the reasons for termination"* before benefits are ended.

None of those obligations is met by an audit log, because an audit log records
what a system *did* rather than demonstrating that what it did **follows from
the rule it claims to have applied.** The difference is the whole subject of
this document.

## 2 · Terms

| Term | Meaning |
|---|---|
| **Subject** | The person or entity a determination concerns. Never identified in this format |
| **Fact** | A typed value asserted by a named source with a declared admissibility |
| **Rule** | A bounded boolean expression over facts. §3 |
| **Determination** | A sealed record of one rule applied to one subject's facts |
| **Verifier** | Any party holding the facts, checking a determination without trusting its issuer |

## 3 · The rule grammar (normative)

A rule is JSON. Exactly one of four shapes:

```
rule      := comparison | { "all": [rule, ...] } | { "any": [rule, ...] } | { "not": rule }
comparison:= { "fact": string, "op": op, "value": literal }
op        := "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "nin"
literal   := boolean | integer | string | [integer|string, ...]
```

**Limits.** Depth ≤ 8. Nodes ≤ 64. Set members ≤ 64. Fact names match
`^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$`, at most 96 characters.
Strings at most 256 characters.

**`all` and `any` MUST NOT be empty.** A vacuously true rule is a decision
about nobody, stated as a decision about somebody.

### 3.1 What the grammar deliberately excludes

No loops, no recursion, no user-defined functions, **no arithmetic**, no
external calls, and no clock. Evaluation is a bounded walk over a bounded tree,
so it is **total**: every rule terminates and yields one of exactly three
values.

This is the load-bearing constraint. A rule that needs more than this is not a
rule, it is a program, and a program cannot be re-run in ten years with
confidence that it means what it meant. It also has a consequence worth stating
plainly: **an implementation of this format cannot compute eligibility.** It can
verify that a computed value satisfied a stated threshold. Deriving the value is
another system's job.

### 3.2 There is no `present` / `absent` operator

This is the most consequential omission and it is deliberate.

A rule cannot ask whether a fact exists. To act on a fact being false, the
false value **must be attested** — `renewal_form_received = false`, carrying a
source and an admissibility class that somebody is accountable for.

Without this, a system cannot distinguish *"we checked and it is not there"*
from *"we never looked"*, and the second silently satisfies the first. In 2024
roughly **69% of 25.2 million Medicaid disenrollments were procedural** —
people removed for missing paperwork rather than for any determination of
ineligibility. That is absence of evidence being treated as evidence of absence,
at national scale.

This format does not make that impossible. **It makes it attributable.** An
institution must assert the absence as a positive, sourced claim rather than
inferring it from silence.

## 4 · Three-valued evaluation (normative)

Values are `true`, `false`, `unknown`. Kleene's strong three-valued logic.

**A fact that is absent, or whose attestation has expired, evaluates to
`unknown` — never to `false`.**

| | `all` | `any` | `not` |
|---|---|---|---|
| any child `false` | `false` | — | — |
| any child `true` | — | `true` | — |
| else any child `unknown` | `unknown` | `unknown` | `unknown` |
| else | `true` | `false` | invert |

A comparison whose literal cannot be compared with the fact's declared type is
an **error**, not `unknown`. Missing data is a fact about the world; comparing
a string to an integer is a mistake in the rule, and it must be refused loudly
rather than absorbed.

### 4.1 Why `unknown` is the whole design

`unknown` is not an error state to be eliminated. It is the answer that says
*we do not know*, and preserving it is what separates this format from a
boolean one.

It is also, in at least one jurisdiction, a legal trigger. **42 CFR
435.916(b)(1)** requires a state to attempt Medicaid renewal from data already
in its possession *before* requesting anything from the beneficiary. Under this
format:

| Re-evaluation | Meaning | Permitted action |
|---|---|---|
| `true` | Still eligible on data held | Renew. Do not contact the person |
| `false` | A determination, with reasons | Act, and give the reasons |
| **`unknown`** | **Cannot determine from data held** | **This — and only this — is when you may lawfully ask** |

## 5 · Canonical form and the rule hash (normative)

```
rule_hash = SHA-256( UTF-8( canonical(rule) ) )
```

`canonical(rule)` is JSON with:

1. Object keys sorted by Unicode code point.
2. No insignificant whitespace.
3. Children of `all` and `any` sorted by their own canonical form — these
   operators are commutative, so two rules differing only in child order are
   the same rule and MUST produce the same hash.
4. `in` / `nin` set members sorted and de-duplicated.
5. Integers rendered without exponent or leading zeros. **Non-integer numbers
   are not permitted anywhere in the grammar**, so no float formatting question
   arises. This is why.
6. Strings normalised to Unicode NFC.

## 6 · Fact commitments (normative)

A determination records a commitment to each fact it read, never the value:

```
value_sha256 = SHA-256( UTF-8( canonical({ "t": fact_type, "v": value }) ) )
```

`fact_type` is one of `bool`, `int`, `str`, `time`. `time` is an integer of
epoch milliseconds. String values are NFC-normalised before hashing.

**The issuer does not retain the value.** A verifier holding the institution's
own record recomputes the digest and compares. This is what makes the format
verifiable *without* trusting the issuer, and it is why erasure of the
underlying facts does not invalidate any determination.

### 6.1 Commitment agility

Every commitment carries `commitment_scheme`, currently `"sha256-v1"`. A
verifier MUST refuse a scheme it does not implement rather than guess.

This exists because commitments cannot be recomputed later — the values are
gone. A format that hard-codes one hash forecloses every future verification
technique, including proving correct application in zero knowledge, which
requires a commitment the prover can work with. The scheme is versioned so that
option stays open; it is not exercised yet.

## 7 · The determination record

```jsonc
{
  "seal_id": "seal_…",
  "scope": "refund.issue",
  "disposition": "bind" | "permit" | "commit",
  "state": "sealed" | "tainted" | "lapsed" | "expired" | "clawed",
  "rule": { … },
  "rule_hash": "…64 hex…",
  "grammar_version": "1",
  "commitment_scheme": "sha256-v1",
  "sealed_by": "agent" | "operator" | "principal" | "custodian",
  "sealed_at": "2026-09-07T12:00:00.000Z",
  "expires_at": "2026-10-07T12:00:00.000Z" | null,
  "reasons": [
    { "path": "all[1]", "fact": "prior_refunds_90d", "op": "lt",
      "value": 3, "truth": "true", "polarity": "direct" }
  ],
  "facts": [
    { "fact": "prior_refunds_90d", "fact_type": "int",
      "value_sha256": "…", "source": "core_ledger",
      "admissibility": "internal", "asserted_at": "…" }
  ],
  "events": [ { "kind": "sealed", "actor": "agent", "occurred_at": "…" } ]
}
```

**There is no subject identifier, by design.** A determination is about a
decision, not about a person. Including one would make a set of determinations
a way to enumerate a population.

### 7.1 Reasons

A reason locates a clause of the rule that carried the outcome. `path` is its
position (`all[1]`, `any[0].not.all[2]`). `polarity` is `negated` when the
clause sits under an **odd** number of `not` segments — a consumer may verify
this by counting, and `not(not(x))` is `direct`.

Two properties MUST hold and SHOULD be tested by any implementation:

- **Sufficiency** — restricting the facts to those the reasons name yields the
  same outcome. Catches under-reporting.
- **Accuracy** — every reason's own truth equals the outcome it is offered for,
  or its negation under `negated` polarity. Catches over-reporting.

Accuracy is the one that matters and the one that is easy to miss. Sufficiency
is monotone: adding wrong reasons only keeps *more* facts, so it can never fail
in the direction of over-reporting. An implementation checking only sufficiency
will happily report that somebody was refused because of a condition they
actually satisfied — which is itself an inaccurate-reason violation.

## 8 · Verification procedure (normative)

A verifier holding a determination and the institution's own record of the
facts:

1. **Check the grammar version.** Refuse an unsupported one. Do not guess.
2. **Check the commitment scheme.** Same.
3. **Recompute `rule_hash`** from `rule` by §5. It MUST match.
4. **Recompute each `value_sha256`** from the held values by §6. A mismatch
   means the value changed or the record is wrong — the verifier reports it and
   does not attempt to decide which.
5. **Re-evaluate** `rule` against the held values by §4.
6. **Compare** the result to `state`:

| Re-evaluation | Consistent states |
|---|---|
| `true` | `sealed`, `clawed`, `expired` |
| `false` | `lapsed`, `clawed`, `expired` |
| `unknown` | `tainted`, `clawed`, `expired` |

7. **Check the reasons** against §7.1.

`clawed` and `expired` are consistent with any outcome: the first records a
person having overruled, the second the determination having run out, and
neither claims anything about the rule.

## 9 · Versioning

`grammar_version` may only be widened in ways that leave every existing rule's
meaning unchanged. Anything that could change how an already-sealed rule
evaluates MUST increment it, and an implementation MUST refuse a version it
cannot reproduce rather than re-decide under semantics nobody agreed to.

**The grammar cannot be narrowed.** Every rule ever sealed is evaluated by it
forever, and a bug in v1 semantics is a bug maintained for the life of the
format, because the alternative is silently re-deciding decided cases.

## 10 · What this format does not do

Stated because a specification that only lists its strengths is marketing.

- **It does not make facts true.** The institution asserts them. A party that
  attests falsely produces a mathematically perfect proof of a wrong decision.
  Admissibility classes narrow this and do not close it.
- **It does not compute eligibility.** §3.1.
- **It does not prove a rule is fair.** It proves a rule was applied. Whether
  three prior refunds is the right threshold is a value judgment, and no format
  derives one.
- **It does not prevent absence being asserted as fact.** §3.2. It makes it
  attributable, which is a different and smaller claim.

## 10a · Conformance

Machine-readable vectors: `spec/vectors/vectors.json`. Plain JSON, no
dependency on any implementation.

An implementation claiming conformance MUST pass all of them. They cover
canonical form and rule hashes (§5), value commitments (§6), three-valued
evaluation (§4), reason sufficiency, accuracy and path construction (§7.1), and
the rules the grammar must refuse (§3).

Writing them found two defects in the reference implementation on the first
run, and a third an hour later:

- set members were sorted but **not de-duplicated**, so `in ["CA"]` and
  `in ["CA","CA"]` — the same rule — produced different hashes and therefore
  two determinations neither of which could be found from the other
- a reason path under `not` carried a **dangling separator** (`not.`)
- path segments were **concatenated without a separator** when nested, giving
  `any[0]not.not` instead of `any[0].not.not`, which makes polarity
  unverifiable by a consumer

Two of those change what a determination *is*, and canonical form decides the
rule hash — so they were free to fix only because no determination has been
sealed in production yet. **After the first one, they would not have been.**

## 11 · Implementations

| | |
|---|---|
| **Reference** | Crimp, `crimpgate.com`. Apache-2.0 |
| **Independent verifier** | `spec/verifier.mjs` — no dependencies, no imports from the reference, runs in Node and in a browser. `spec/verifier.html` is the same code as a keyless offline page |

The second exists to test **this document**, not the software. A specification
is only a standard if a stranger can implement it from the text, and the only
way to find out whether the text is sufficient is to write a second
implementation and see whether the two agree. They pass the same vectors. If
they ever disagree, at least one is wrong, and establishing which is the point.

Alternative implementations are welcome and are the reason this is published.
A determination produced by one implementation MUST verify under another.
