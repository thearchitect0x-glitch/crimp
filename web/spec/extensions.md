<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Determination Format — extensions in 0.2

**Status: prepared, not published.** This file documents every fact
family, finding class, event kind, record field and error code the 0.2
upgrade added, so that a second implementer has the whole surface in one
place. It is written to be publishable as a defensive publication; whether
and when it is published is a decision for the company, and nothing in the
repository publishes it.

Everything here is *additive*. A 0.1 record validates unchanged under 0.2
(vector: "a record without rule_ref or as_of is a valid record"), and a 0.1
verifier ignores every new field because none participates in a hash it
already checks.

---

## 1 · Record fields (SPEC §7.0a–f)

| Field | Section | Type | Hashed? | Meaning |
|---|---|---|---|---|
| `as_of` | §7.0a | ISO timestamp or null | no | The date the decision is *about*; selects the rule version; never read by evaluation |
| `rule_ref` | §7.0a | object or null | no | Snapshot of the registered rule: `ruleset, rule_id, version, legal_authority, effective_from, effective_to`. `version` MUST equal `rule_hash` |
| `facts[].attester` | §7.0b | string or null | no | The credential that asserted the fact, as the issuer identifies it |
| `remedy` | §7.0d | object or null | no | Every minimal correction set, each fact described by its cell; `target`, `exhaustive`, `evaluations` |
| `review_flagged_at` | §7.0e | ISO timestamp or null | no | When a ruling against another determination under the same rule placed this one under review |
| `signature` | §7.0f | `{kid, alg, sig}` or null | — | Ed25519 over the generic canonical JSON of the sealed core |

The **sealed core** (what `signature` covers) is exactly: `seal_id, scope,
disposition, rule, rule_hash, grammar_version, sealed_by, sealed_at,
expires_at, as_of, rule_ref, reasons, facts, remedy`.

Grammar (§3.x): **constant conclusions are refused** at admission —
any subtree that evaluates the same under every assignment in which its
facts are present. Exact per single fact; bounded at 65 536 assignments
across facts. Admission narrowed; evaluation unchanged; `grammar_version`
stays `1`. Set operators over booleans are refused (they could never
evaluate).

---

## 2 · Fact families and catalogue classes

Facts remain scalar (`bool`, `int`, `str`, `time`) with dotted names. The
0.2 upgrade adds no fact *type*; it adds **conventions** — families of
scalar facts under a prefix — and a **catalogue** that declares what a
fact is.

### 2.1 Catalogue classes

| Class | Meaning | Constraint |
|---|---|---|
| `plain` | An ordinary fact | — |
| `delivery` | A notice's delivery status | `str`, values fixed to `delivered \| returned \| unknown` |
| `non_response` | "They did not respond / return / appear" | MUST name a `delivery` fact as its guard (`guarded_by`, `guard_value`, default `delivered`) |

A workspace with any catalogued fact is **closed**: rules and attestations
may name only catalogued facts. A synonym for a guarded fact is therefore
not detected — it is impossible.

### 2.2 The notice-delivery convention

A notice is a prefix, e.g. `notice.renewal.*`:

| Fact | Type | Values | Role |
|---|---|---|---|
| `notice.<name>.delivered_status` | `str` | `delivered \| returned \| unknown` | The guard. `unknown` is a positive claim by a named source |
| `notice.<name>.channel` | `str` | `mail \| e_notice \| portal \| sms` (convention; enforce with `allowed_values`) | |
| `notice.<name>.sent_at` | `time` | epoch ms | |
| `notice.<name>.notice_id` | `str` | | |
| `notice.<name>.evidence` | `str` | e.g. `usps_return`, `ncoa_match`, `read_receipt` | |

Staleness is the existing fact expiry: attest delivery with an
`expires_at` matching the response window.

**Guard semantics (issuing-system behaviour, §7.0c):** before evaluation, a
`non_response` fact is withheld unless its guard holds. The evaluator is
unchanged; Kleene monotonicity keeps the record reproducible; a guard that
*held* is committed to `facts[]`, a withheld fact is not. Applied on
re-evaluation too. Refusal reason: `delivery_unattested`.

### 2.3 The adjudication family

Attested about the appellant by the hearing authority as a named source:

| Fact | Type | Values |
|---|---|---|
| `adjudication.ruling` | `str` | `reversed \| affirmed \| remanded` |
| `adjudication.ruleset` | `str` | ruleset of the rule the ruling condemns |
| `adjudication.rule_id` | `str` | its id |
| `adjudication.pattern` | `str` | optional: a fact the rule may not rest on |
| `adjudication.authority` | `str` | `fair_hearing \| state_review \| court \| …` |
| `adjudication.date` | `time` | when the ruling issued |

A `reversed` ruling naming a rule propagates once (see `systemic_review`).
`fair_hearing_90_day` is met by `adjudication.ruling`.

### 2.4 Clocks (not facts)

A clock is a record-bound object — name, start, due, `running | met |
missed` — that a rule **cannot** read. Seven federal defaults in
`clocks.config.ts`, each `TODO(legal-confirm)`. A missed clock is a finding.

---

## 3 · Finding classes

A finding is addressed to the institution, carries **no subject
identifier**, and never changes an outcome — there is no code path from
`findings` to a determination's state.

| Class | Subject kind | Raised by | Detail |
|---|---|---|---|
| `agency_timeliness` | `clock` | the sweep, once per clock, when due passes unmet | clock, scope, authority, started/due, resolved_at, late_hours |
| `systemic_review` | `rule` | the sweep, once per reversed ruling naming a rule | ruleset, rule_id, pattern, adjudication (authority, date), affected seal ids, count |
| `drift` | `rule` | the sweep, at most hourly per workspace, once per rule/metric/window | metric, baseline (mean, sd, days), current (rate, evaluations), threshold |

Drift parameters (engineering, stated): 14-day baseline, 24-hour window,
lower of mean + 3σ and 2 × mean, ≥ 20 evaluations, ≥ 0.05 absolute move,
≥ 3 baseline days.

---

## 4 · Event kinds added

| Kind | On | Detail |
|---|---|---|
| `systemic_review` | each affected determination | the ruling's identity |
| `lapsed` (detail extended) | a lapsed `bind` | `harm{ programme, days_without_coverage, days_owed, window_days, authority, refused_at, reversed_at }` |
| `sealed` (detail extended) | a procedural determination | `ex_parte{ ruleset, rule_id, version, outcome, missing }` or `{ outcome: "not_declared" }` |
| `tainted` (detail extended) | a guarded determination | `guarded[]`: which fact was withheld and why |

---

## 5 · Error codes added

`constant_conclusion`, `invalid_citation`, `rule_window_overlap`,
`unknown_ruleset`, `unknown_rule`, `no_rule_in_force`, `rule_ref_mismatch`,
`rule_scope_mismatch`, `uncatalogued_fact`, `catalogue_type_mismatch`,
`catalogue_type_fixed`, `value_not_allowed`, `guard_required`,
`guard_not_delivery`, `unknown_clock`, `programme_not_configured`,
`language_unavailable`, `cross_program_fact_available`,
`ex_parte_rule_not_in_force`, `procedural_needs_registry`,
`source_class_fixed`, `disposition_fixed_by_rule`,
`rule_has_no_disposition`. Each carries a stable `code`, a sentence that
says what to do, and a `detail` object; agents branch on `code`.

---

## 6 · Defensive publication, and the timestamp procedure

**Why publish the format and not the measurement.** The format — what a
determination *is*, how it is hashed, signed and verified — is worth more
open than closed: a second implementation is what makes it a standard, and
this document plus `docs/SPEC.md`, `spec/verifier.mjs` and
`spec/vectors/vectors.json` is what a second implementer needs. What the
company protects is elsewhere and is not described in this file.

**Prior-art timestamping.** The procedure already used for the company's
own disclosure documents applies to any file here before it is published:

1. Produce the file's SHA-256: `shasum -a 256 <file>`.
2. Anchor it in the Bitcoin blockchain with OpenTimestamps:
   `ots stamp <file>` → `<file>.ots`. The `.ots` proof is small, free, and
   needs no account; it becomes verifiable once the calendar's aggregate
   is mined (typically within hours).
3. Upgrade and verify later: `ots upgrade <file>.ots`, then
   `ots verify <file>.ots` against a local or public Bitcoin node — no
   trust in the calendar server is required.
4. Keep the file and its `.ots` together, unchanged. A changed byte is a
   different hash and an unrelated proof.

A file timestamped this way establishes that its content existed no later
than the anchoring block's time. That is what a defensive publication
needs, and it is the same evidence the invention disclosure already has.

**Nothing in this repository publishes anything.** Publishing —
committing this file to a public repository, posting it, or filing it —
is a company decision, to be taken after the provisional application is
on file, and not before.
