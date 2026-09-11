<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# SNAP as a Crimp programme — a worked configuration

`src/programmes/snap.ts` is what a state SNAP agency would commit to run
certification, recertification and the work requirement through Crimp:
seven sources, twenty-four catalogued facts, one ruleset, ten rule
versions — every threshold a literal with its citation, every number a
federal FY 2026 figure marked `TODO(legal-confirm)`. `scripts/seed-snap.ts`
applies it to a workspace; `test/integration/snap.test.ts` walks a
household through a grant, a denial, a procedural denial, expedited
service, the work requirement across H.R. 1, and the notice.

It was built to find out where the format meets real policy and where it
does not. It found four things. They are the point of this document.

## What is in it

| Rule | Kind | Authority | Note |
|---|---|---|---|
| `cert.gross_income` | denial | 7 CFR 273.9(a)(1) | 130% of poverty, enumerated by household size 1–12 |
| `cert.net_income` | denial | 7 CFR 273.9(a)(2) | 100% of poverty, enumerated; reads a **derived** net income |
| `cert.resources` | denial | 7 CFR 273.8(b) | $3,000 / $4,500 with an elderly or disabled member; not for BBCE states |
| `cert.eligible` | grant | 7 CFR 273.9(a), 273.8(b), 273.2(f)(1) | Verifications complete and every test met; reads derived percent-of-poverty facts |
| `cert.expedited` | grant | 7 CFR 273.2(i)(1) | < $150 gross and ≤ $100 liquid; destitute migrant; or the shelter criterion as a **derived** fact |
| `cert.interview_missed` | procedural denial | 7 CFR 273.2(e)(3), (h)(1)(i) | Guarded by delivery of the Notice of Missed Interview |
| `cert.verification_missing` | procedural denial | 7 CFR 273.2(h)(1)(i), (c)(5) | Guarded by delivery of the verification request |
| `recert.not_returned` | procedural termination | 7 CFR 273.14(b)(1), (b)(3) | Guarded by delivery of the notice of expiration |
| `work.abawd_time_limit` v1 | denial | 7 CFR 273.24 (pre-H.R. 1) | Ages 18–54; in force 1 Oct – 1 Nov 2025 |
| `work.abawd_time_limit` v2 | denial | 7 CFR 273.24 as amended by Pub. L. 119-21 §10102 | Ages 18–64; in force from 1 Nov 2025 |

Clocks (`clocks.config.ts`): `snap_30_day`, `snap_expedited_7_day`.
Appeal rights (`notice.config.ts`): 90 days, continued benefits on request
within the advance-notice period. Restoration (`restoration.config.ts`):
12 months.

Sources carry their programme, so a Medicaid-verified income used at a
SNAP recertification is on the record as Medicaid's.

## Finding 1 — the arithmetic is outside the gate

The grammar has no arithmetic and no fact-to-fact comparison, by design
(SPEC §3: "not a language"). Three SNAP tests need arithmetic:

- **Net income** is gross minus the 273.9(d) deductions — 20% of earned
  income, a standard deduction by household size ($209 / $223 / $261 /
  $299), dependent care, medical over $35 for elderly or disabled members,
  and excess shelter over half of the remainder, capped at $744. This is
  where SNAP's payment errors actually live.
- **Expedited criterion (iii)**: gross income plus liquid resources less
  than the household's shelter costs — a sum and a comparison of facts.
- **Age** from a date of birth.

Each arrives as a *derived fact* — `income.net_monthly`,
`expedited.shelter_exceeds_means`, `hh.age` — computed by the state's
benefit engine and attested by it. The record commits to the derived
value's digest, the reasons name it, the remedy says what it would need to
be. What the record does not carry is the derivation, so an examiner
re-running the record verifies the *test* and takes the *arithmetic* on the
attester's word. For net income that is the QC-relevant half.

The gross and net *tests* themselves are expressible exactly — by
enumerating household size, so `cert.gross_income` is
`any[ all[hh.size = n, income.gross_monthly > limit(n)] … ]` for n = 1..12,
40 nodes of the 64 allowed. That keeps every dollar threshold in the
record and lets the remedy say "at most $3,483 for a household of four".

**Decision needed — BLOCKERS B3:** whether to add bounded arithmetic to the
grammar (a §9 widening that every implementation must carry forever), or
to accept derived facts and instead require the deriving engine to be
*named and versioned* on the attestation. Recommended: the second, first —
it is a catalogue attribute, not a format change — and revisit the first
only if a buyer's auditors require the deductions to be re-runnable from
the record.

## Finding 2 — enumeration stops

Above twelve members the income test is not expressible without
arithmetic (the each-additional rule). The rule then does not hold, the
seal is `not_applicable`, and the agency decides on the merits by other
means. Twelve is stated in `SNAP_FY2026.maxHouseholdSizeEnumerated`; a
state may raise it until the node limit bites (each size costs three
nodes).

## Finding 3 — the remedy names facts a person cannot change

For a four-person household denied at $3,600 gross, the remedy is exact
and reports every minimal correction: income into any cell at or below
$3,483 (four cells), **or a household size with a higher threshold (nine
sizes)**, or categorical eligibility, or an elderly or disabled member.
All four are mathematically true. One is advice. The notice prints, among
its options, *"Number of people in the SNAP household is at least 5."*

The remedy has no notion of actionability. The counterfactual-explanation
literature has one (Ustun et al. 2019 distinguish actionable, conditionally
actionable and immutable features); the catalogue does not. **B4** proposes
a `mutability` attribute on catalogued facts (`actionable` — income,
verification; `circumstantial` — household size, age; `fixed` — identity)
with the *notice* ordering by it and the *record* unchanged.

## Finding 4 — ex parte is Medicaid's

Cap 7's precondition — decide on the merits from facts on file before any
procedural denial — is what 42 CFR 435.916(b)(1) states for Medicaid. SNAP
regulations do not license it: an application cannot be certified without
the interview (7 CFR 273.2(e)(2)) unless the state holds an interview
waiver, and recertification requires the household's own application
(273.14(b)(3)). So this ruleset declares **no ex parte rule**, every
procedural seal records `ex_parte: not_declared`, and the protection
against a wrongful procedural denial here is cap 1's delivery guard: the
Notice of Missed Interview (273.2(e)(3)) must have *reached* the household
before "did not appear" can be read. A state with an interview waiver for
elderly/disabled no-earned-income households may set `exParteRule` to
`cert.eligible` for that population.

## What was fixed because of this exercise

The remedy is exact — one set per cell — and the notice printed it that
way: four lines of a dozen clauses for "gross income at most $3,483". The
page now collapses cells on one fact into their union interval and groups
sets over the same facts (`remedyLines` in `notice.ts`). The record is
untouched.

## Not modelled, and why

- **Benefit amount.** The allotment is a computation (maximum allotment by
  size less 30% of net income); Crimp records determinations, not amounts.
- **Broad-based categorical eligibility** is a state option with its own
  gross limit (up to 200%); `hh.categorically_eligible` is a fact the state
  attests, and the resource rule should not be committed in a BBCE state.
- **Advance notice of adverse action** (273.13, 10 days) — blocker B2.
- **The interview itself** as a clock (273.2(e)(3)'s scheduling), and the
  30-day clock's "fault" analysis (273.2(h)) — the clock exists; whose fault
  the delay was is a caseworker's finding, attested as a fact.

## Before a deployment

Every figure in `SNAP_FY2026` against the FNS FY 2026 COLA memo and the
state's own standards; whether the state is BBCE; the state's interview
waivers; the H.R. 1 effective date as the state implemented it; and B3, B4.
