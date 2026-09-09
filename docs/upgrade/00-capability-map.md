<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Upgrade · Phase 0 — capability map

**9 September 2026.** Written against `integration-check` — the merge of PRs
#10–#18 — because the five things Phase 0 says to read (the spec, the
conformance suite, the evaluator, the re-evaluation scheduler, the second
implementation) only coexist there. Written against `main`, this map would
report as MISSING things that exist. The cost of that choice is stated at the
end.

State of the base at the time of writing, measured not recalled:

```
287 tests pass · 32 conformance vectors × 2 implementations · 19 fuzz properties
10 migrations apply to an empty database · working tree clean
```

Nothing below modifies the format. Nothing below is code.

---

## The six inviolable properties — do they hold today?

| # | Property as stated in the brief | Holds? | Where, and what is different |
|---|---|---|---|
| 1 | Caller submits a **rule from a pre-committed ruleset** and **facts with source, attester, timestamp**; no input carries a conclusion | **PARTIAL** | Rule + facts with no conclusion input: `src/domain/seal.ts` `SealInput` — there is no outcome field, and `disposition` names what *kind* of determination the rule would produce, not whether it does. Source and timestamp: `attestations.source`, `asserted_at`. **Attester is not recorded** — the principal is known at `attest()` and dropped. **There is no ruleset**: rules are submitted inline per seal. |
| 2 | Exactly yes / no / unknown; unknown never collapses to no | **EXISTS** | `src/domain/evaluate.ts` — Kleene strong three-valued. Vocabulary is `true / false / unknown`. Fuzz-verified (`test/unit/fuzz-rule.test.ts`), conformance-vectored (`spec/vectors/vectors.json` → `evaluate`), second implementation agrees (`spec/verifier.mjs`). |
| 3 | No rule may act on absence; absence must be an attributed positive claim | **EXISTS** | `src/domain/rule.ts` — no `present`/`absent` operator; the `refuse` vectors include one. **Tested this morning**, see finding F1 below: a presence *test* is expressible, but absence can never produce TRUE, and UNKNOWN cannot seal (`facts_not_attested`). An expired attestation also reads as absent (`seal.ts` `loadFacts`). |
| 4 | Standing decisions re-evaluated continuously; when the reason no longer holds, marked void and a reversal emitted | **EXISTS** | `src/domain/seal.ts` `reevaluate()`, `src/worker/sweep.ts`, `src/worker/main.ts`. Vocabulary: **`lapsed`** not `void`; the reversal is a `seal_events` row of kind `lapsed`. Two triggers — change-driven (`markDue()`) and cursor-driven (`last_evaluated_at`) — because either alone is insufficient; see migration 009. |
| 5 | No LLM / ML in evaluation; deterministic and reproducible | **EXISTS** | `evaluate()` is a pure function over `(rule, facts)`; the fuzz suite asserts purity; no I/O, no clock, no model anywhere on the path. `ROADMAP.md` records "natural language on the decision path" as explicitly not doing. |
| 6 | Open, versioned record format; backward compatible; conformance suite | **EXISTS** | `docs/SPEC.md` v0.1; `grammar_version` on every seal; `commitment_scheme` for agility; `spec/vectors/` + `scripts/conformance.ts` + `scripts/conformance-verifier.mjs`, both in CI. The grammar may only widen; a narrowing "would silently re-decide decided cases." |

Two vocabulary maps to carry into every later phase, so the brief and the
code stop talking past each other:

| Brief says | Code says |
|---|---|
| yes / no / unknown | `true` / `false` / `unknown` |
| record | seal · determination |
| void, reversal | `lapsed`, `seal_events.kind = 'lapsed'` |
| ruleset commit | *(does not exist)* |
| finding | *(does not exist as a table)* |

---

## Phase 0 findings on the rule language

**Not Turing-complete — CONFIRMED.** A rule is a tree of `all` / `any` / `not`
over comparisons. No loops, recursion, user functions, arithmetic, external
calls, or clock (`rule.ts` header). Bounded at depth 8 and 64 nodes
(`LIMITS`). Evaluation is a single walk, so it is total: every rule terminates
with one of three values.

**Rejects predicates over missing facts — CONFIRMED.** A missing fact is
`unknown` at the leaf (`evaluate.ts` `compare()`), the seal path refuses
`unknown` (`seal.ts`, `facts_not_attested`), and an attestation past its
`expires_at` is not read at all. There is no operator that can see whether a
fact exists.

**Rejects constant-conclusion rules — PARTIAL, and the finding is precise.**

> **F1.** A rule that references no fact is refused (`validateRule`, *"A rule
> must reference at least one fact"*). A rule that references facts can never
> be constant across all assignments, because absence yields `unknown` at every
> leaf. **However**, the following is accepted and is a tautology over any
> *present* value of `a`:
>
> ```json
> {"any": [{"fact":"a","op":"eq","value":1}, {"fact":"a","op":"ne","value":1}]}
> ```
>
> Measured: `a = 1 → true`, `a = 7 → true`, `a absent → unknown`. So it is a
> smuggled **presence test** — `true` exactly when `a` was attested. Its
> negation is `false` when present and `unknown` when absent, so **absence still
> cannot be acted on**: nothing here can seal on the strength of a missing
> fact, and property 3 holds. What it *can* do is decide nothing about the
> person while looking like a rule, which is what a constant-conclusion check is
> for. Detecting it in general is SAT, but this grammar is bounded: for each
> fact, the literals it is compared against partition its domain into finitely
> many cells; a rule is a presence-tautology iff it evaluates `true` in every
> cell of the product. At 64 nodes the product is small. **Recommended for
> Phase 1 as a `validateRule` addition; not blocking, because it does not
> breach any of the six properties.**

---

## The ten capabilities

| # | Capability | Status | What exists · file references · note |
|---|---|---|---|
| 1 | **Delivery attestation as precondition to non-response findings** | **PARTIAL** | The *mechanism* "a rule in this scope must reference fact X" exists as `requiredFacts` → `rule_missing_required_fact` (`seal.ts` ~L205). **Measured this morning: it is caller-supplied** (`routes/index.ts` L86 `req.body.required_facts`), so a caller can omit it — it is a declaration, not policy. No `notice_delivery` fact type; facts are scalar (`bool/int/str/time`), so a six-field delivery record is either a new structured-fact table or dotted scalars (`notice.<id>.delivered_status`), which the 4-segment fact-name grammar already permits. Item (d), "synonym predicate rejected at ruleset commit," needs a commit step and semantic tags neither of which exist — depends on **8**. |
| 2 | **Minimal missing set — "what would make this yes"** | **PARTIAL** | `src/domain/explain.ts` `reasons()` computes the clauses that *decided* an outcome, with SUFFICIENCY and ACCURACY properties mutation-tested (`test/unit/fuzz-explain.test.ts`). `disclose()` gives `wouldHaveNeeded` — the nearest passing value for one failed ordered clause. What is missing is the *set-cover*: the smallest set of facts whose change flips the whole tree. The tree structure makes this exact and cheap (`all` → every false child must flip; `any` → any one; `unknown` → the facts to attest). Bound: the grammar's own 64 nodes. Extend `explain.ts`; the remedy is the near-complement of the reason set. |
| 3 | **Clocks as facts** | **MISSING** | Only timing that exists: `seals.expires_at` (determination expiry), `claw_cooling_off_s` (reversal delay), `attestations.expires_at` (fact staleness). No named clocks, no `agency_timeliness`, **no findings table at all**. Architecturally compatible: the evaluator must stay clock-free (`evaluate.ts` header, *"WHY IT CANNOT SEE A CLOCK"*), and the brief agrees — a missed clock is a *finding*, never an outcome change. The scheduler (`worker/sweep.ts`) is the natural place to advance clocks. |
| 4 | **Notice as derivation** | **PARTIAL** | `src/domain/record.ts` `proof()` already produces outcome, rule, reasons, facts-with-sources and events as a pure projection of the record, with no subject identifier. Missing: legal citation and effective date (**needs 8**), remedy (**needs 2**), clocks (**needs 3**), per-program appeal-rights config, plain-text/HTML renderers, reading-level report, translation interface. The byte-identical property is already the shape of `proof()`. |
| 5 | **Restoration and harm computation** | **MISSING** | Inputs exist: `sealed_at`, `settled_at` (set on `lapsed`), the `lapsed` event, scope. `insight.ts` counts the *quadrant* — how many were wrong — but nothing computes *magnitude*. No per-program config, no `harm{}` on the event, no ledger. Note the quadrant deliberately excludes `clawed` from "wrong"; harm must match that rule or the two will disagree. |
| 6 | **Systemic-error propagation** | **PARTIAL** | `rule_hash` over canonical form (`rule.ts` `canonicalRule`) is a de facto rule identity today — *"what lets two agents that expressed the same policy in different orders be recognised as having applied the same rule."* `markDue()` (`seal.ts`) is the enqueue primitive. Missing: `adjudication` fact type, the query "every open seal sharing this rule_hash," the `systemic_review` finding. Works on `rule_hash` now; works on rule id once **8** exists. |
| 7 | **Cross-program reconciliation** | **PARTIAL — design divergence** | The fact store is **already** one per subject per workspace (`attestations` keyed by blinded-alias-resolved `subject_id`), and facts are **not** namespaced by program. So a Medicaid rule reading `income.monthly` sees a SNAP-attested value today, with `source` carrying provenance. The brief assumes program-namespaced facts and asks Crimp to bridge them; the repo's design makes the bridge unnecessary. **What is genuinely missing** is the specific behaviour "before a procedural `no` in A, check whether B's facts satisfy the condition" as a named reason — which is a special case of capability **2** (the remedy set already names the fact; it needs the *source program* attached). Recommendation: keep the shared store, deliver 7 through 2 + 8 rather than as its own mechanism. |
| 8 | **Ruleset versioning with legal citations** | **EXISTS as of cap-08** (was MISSING) · retroactive flag → blocker B1 | No rulesets, no rule ids, no `legal_authority`, no `effective_from/to`, no as-of selection. `grammar_version` versions the *evaluator*, not the *rule*. **1(d), 6, 7 and 10 all depend on this.** Design constraint from the codebase: a seal must keep the rule *as written*, so it can be re-run without any registry. So a ruleset reference must be **additive** — `seals.rule_ref` (nullable: ruleset, rule id, version, citation) beside the inline rule, not instead of it. Old seals carry null and still validate. |
| 9 | **Drift and outage detection** | **PARTIAL** | `src/domain/insight.ts` computes rates over windows — source reliability, the quadrant, cliffs — and `sweepLag()` (`seal.ts`) is an outage signal for the correction channel. Missing: rolling rate per rule per reason code, a baseline + σ, the `drift` finding, and (again) a findings table. Note the volume-floor discipline in `insight.ts`: an inferential rate below the floor is null, a census count never is. Drift is inferential and should inherit the floor. |
| 10 | **Human decisions through the same gate** | **PARTIAL** | There is no separate human path and no free-text outcome anywhere: a caseworker seals through `/v1/seals` with an `operator`/`principal` key, and `sealed_by` records the authority (`seal.ts`). "Rule selection from the committed ruleset" needs **8**. "Log the actor as attester on every fact" is **MISSING** — `attestations` has `source` (a declared system) but no `attester` (the credential that asserted). One column. |

### Cross-cutting gaps, which is where the real work is

Reading the table by dependency rather than by number:

| Gap | Needed by | Shape |
|---|---|---|
| **Rule registry** — id, version, citation, effective dates, as-of selection | 1(d) · 6 · 7 · 8 · 10 | **Landed in cap-08.** `rulesets` / `rules` (migration 011), additive `seals.rule_ref` + `seals.as_of`; the inline rule stays |
| **Findings table** — class, subject (seal / rule / tenant), detail, occurred_at | 3 · 6 · 9 | One table, one event kind per finding class, never an outcome change |
| **Attester on attestations** | property 1 · 10 | One nullable column, populated from the principal, old rows null |
| **Per-program config** — clocks, restoration windows, appeal-rights text | 3 · 4 · 5 | Config with `TODO(legal-confirm)` and federal defaults, per the brief |

### The order the brief gives, and the order the dependencies give

The brief says implement 1 → 10. The dependency graph says **8 first**, or at
minimum the *schema* for 8 first: capability 1(d) cannot be finished without a
commit step, and doing 1 before 8 means building synonym rejection on ad-hoc
rules and rebuilding it on registered ones.

This is recorded here rather than silently re-sequenced. Proposed order, with
the reason: **8 (schema + as-of selection) → 1 → 2 → 3 → 4 → 5 → 6 → 7-via-2 →
9 → 10 → Phase 2.** F1 (presence-tautology rejection) slots in with 1, since
both are `validateRule` work.

---

## Where the repository already does better than the brief describes

The brief says to keep these and note them. Noted:

- **Absence is broader than the brief's rule.** Not only is there no absence
  operator; an attestation past its own `expires_at` reads as absent too. Stale
  data is `unknown`, which is 42 CFR 435.916 in one clause.
- **Re-evaluation has two triggers, and the reason is measured.** Change-driven
  alone cannot see expiry; cursor-driven alone cannot scale. Migration 009
  records the defect that proved it: a sweep ordered by `sealed_at LIMIT 100`
  never reached the hundred-and-first determination.
- **Reasons carry two verified properties.** Sufficiency catches under-reporting;
  accuracy catches over-reporting, which sufficiency structurally cannot. Five
  mutations, five caught. The brief's cap 2 builds on this rather than replacing it.
- **Reason disclosure has two fidelities and is recorded.** The value-bearing
  form is the counterfactual the model-extraction literature warns about, gated
  on authority and written to `seal_events` as `disclosed`. Cap 4's notice
  should consume the *clause-only* form by default.
- **The format has a second implementation.** `spec/verifier.mjs` was written
  from the specification text, imports nothing from `src/`, and passes the same
  vectors. Every Phase 1 format change must keep both green — that is what "extend
  the conformance suite" means here.

---

## Constraints this map is honest about

- **Base branch.** This work sits on the merge of nine unreviewed PRs. It cannot
  land before they do. That is the maintainer's queue and it does not change
  what is correct here, but it is stated so nobody is surprised.
- **No Phase 1 design question is resolved in this document.** Where the brief
  and the code disagree (rulesets, program namespacing, vocabulary), the
  disagreement is recorded and a direction is proposed, not decided.
- **Nothing was published externally.** Phase 2 asks for defensive-publication
  files to be *prepared*, not released; the provisional is still unfiled.
