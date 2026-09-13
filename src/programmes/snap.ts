// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * SNAP, as a Crimp programme: the catalogue, the sources, the ruleset and
 * the rules a state agency would commit for certification, recertification
 * and the work requirement — every threshold a literal with its citation.
 *
 * This is a worked configuration, built to find out where the format meets
 * real policy and where it does not. It found four things, recorded in
 * docs/programmes/snap.md and BLOCKERS.md (B3, B4):
 *
 *   1. ARITHMETIC. The grammar has none, by design. SNAP's net income test
 *      is gross minus deductions (a 20% earned-income deduction, a standard
 *      deduction by household size, an excess-shelter deduction capped at
 *      $744, …) and the grammar cannot express it. Net income therefore
 *      arrives as a DERIVED fact the state's benefit engine computed, and
 *      the record commits to its digest but not its derivation. The same
 *      holds for expedited criterion (iii) (income + resources < shelter)
 *      and for age (a date subtraction). The gross and net TESTS, by
 *      contrast, are expressible exactly by enumerating household size
 *      (1–12 below), which keeps every dollar threshold in the record.
 *   2. HOUSEHOLD SIZE. Enumeration stops at 12. A larger household's test
 *      is not expressible without arithmetic; the rule then does not hold
 *      and the agency decides on the merits by other means. Stated here
 *      rather than hidden.
 *   3. ACTIONABILITY. The remedy for a gross-income denial names two facts
 *      that would change it: income, and household size. Both are true;
 *      only one is advice. The remedy has no notion of which facts a person
 *      can change, and the notice prints both. B4.
 *   4. EX PARTE IS MEDICAID'S. SNAP regulations do not license deciding a
 *      certification from facts on file when the household has not been
 *      interviewed (7 CFR 273.2(e)(2), 273.14(b)(3)); a state with an
 *      interview waiver may. So this ruleset declares no ex parte rule, and
 *      the protection against procedural denial here is cap-01's: the Notice
 *      of Missed Interview (273.2(e)(3)) must have reached the household.
 *
 * Every number is a federal FY2026 figure (effective 1 Oct 2025) as
 * published in the FNS COLA memo and transmitted by states; each is
 * TODO(legal-confirm) before a deployment, and a state's own standards may
 * differ (BBCE states, for one, apply no resource test at all).
 */
import { getPool } from '../db/pool.js';
import type { Principal } from '../domain/auth.js';
import { catalogueFact } from '../domain/catalogue.js';
import { declareSource } from '../domain/sources.js';
import { declareRuleset, commitRule, type RegisteredRule } from '../domain/registry.js';
import type { Rule } from '../domain/rule.js';

/**
 * FY 2026, 48 states and DC. TODO(legal-confirm) against the FNS FY 2026 COLA
 * memo (usda.gov/sites/default/files/guidance-documents/fns.snap-cola-fy26memo.pdf),
 * effective 1 Oct 2025; the income table below is as transmitted by Maryland
 * FIA in AT 26-05 (3 Oct 2025), which reproduces the memo's 48-state figures.
 */
export const SNAP_FY2026 = {
  effectiveFrom: new Date('2025-10-01T00:00:00Z'),
  /** 130% of poverty, monthly, by household size; then each additional member. 7 CFR 273.9(a)(1). */
  grossLimit: [0, 1696, 2292, 2888, 3483, 4079, 4675, 5271, 5867] as const,
  grossEachAdditional: 596,
  /** 100% of poverty, monthly. 7 CFR 273.9(a)(2). */
  netLimit: [0, 1305, 1763, 2221, 2680, 3138, 3596, 4055, 4513] as const,
  netEachAdditional: 459,
  /** 7 CFR 273.8(b). TODO(legal-confirm): FY 2026 figures; BBCE states apply none. */
  resourceLimit: 3000,
  resourceLimitElderlyDisabled: 4500,
  /** 7 CFR 273.2(i)(1). */
  expedited: { grossLt: 150, liquidLte: 100 },
  /** 7 CFR 273.24 as amended by Pub. L. 119-21 (H.R. 1) §10102; FNS: applications processed on or after 1 Nov 2025. */
  abawd: {
    before: { ageMin: 18, ageMax: 54 },
    after: { ageMin: 18, ageMax: 64, effectiveFrom: new Date('2025-11-01T00:00:00Z') },
    hoursMonthly: 80, monthsIn36: 3,
  },
  /** Beyond this the income tests are not expressible without arithmetic. See finding 2. */
  maxHouseholdSizeEnumerated: 12,
  /** For the record and the notice only: the net-income derivation the grammar cannot carry. */
  deductions: { standard: { '1-3': 209, '4': 223, '5': 261, '6+': 299 }, earnedIncomePct: 20, shelterCap: 744 },
} as const;

/** The threshold for a household size, with the each-additional rule applied above eight. */
export function limitFor(table: readonly number[], eachAdditional: number, size: number): number {
  return size <= 8 ? table[size]! : table[8]! + eachAdditional * (size - 8);
}

/**
 * `any[ all[hh.size = n, fact gt limit(n)] … ]` for n in 1..12: the income
 * test as an enumeration, so every dollar figure is a literal in the record
 * and the remedy can say "at most $3,483 for a household of four".
 */
function overLimitBySize(fact: string, table: readonly number[], each: number): Rule {
  const branches: Rule[] = [];
  for (let n = 1; n <= SNAP_FY2026.maxHouseholdSizeEnumerated; n++) {
    branches.push({ all: [
      { fact: 'hh.size', op: 'eq', value: n },
      { fact, op: 'gt', value: limitFor(table, each, n) },
    ] });
  }
  return { any: branches };
}

export const SNAP_RULES: ReadonlyArray<{
  ruleId: string; rule: Rule; legalAuthority: string; disposition: 'bind' | 'permit';
  effectiveFrom: Date; effectiveTo?: Date; note: string;
}> = [
  {
    ruleId: 'cert.gross_income', disposition: 'bind',
    legalAuthority: '7 CFR 273.9(a)(1); 7 CFR 273.10(e)(1)(i)(A)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'Gross income over 130% of poverty for the household size. Not applied to households with an elderly or disabled member, nor to categorically eligible households.',
    rule: { all: [
      { fact: 'hh.categorically_eligible', op: 'eq', value: false },
      { fact: 'hh.elderly_or_disabled', op: 'eq', value: false },
      overLimitBySize('income.gross_monthly', SNAP_FY2026.grossLimit, SNAP_FY2026.grossEachAdditional),
    ] },
  },
  {
    ruleId: 'cert.net_income', disposition: 'bind',
    legalAuthority: '7 CFR 273.9(a)(2)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'Net income over 100% of poverty for the household size. income.net_monthly is DERIVED by the state benefit engine (gross less 273.9(d) deductions); the grammar cannot carry that arithmetic — finding 1.',
    rule: { all: [
      { fact: 'hh.categorically_eligible', op: 'eq', value: false },
      overLimitBySize('income.net_monthly', SNAP_FY2026.netLimit, SNAP_FY2026.netEachAdditional),
    ] },
  },
  {
    ruleId: 'cert.resources', disposition: 'bind',
    legalAuthority: '7 CFR 273.8(b)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'Countable resources over the limit. BBCE states apply no resource test; do not commit this rule there.',
    rule: { all: [
      { fact: 'hh.categorically_eligible', op: 'eq', value: false },
      { any: [
        { all: [{ fact: 'hh.elderly_or_disabled', op: 'eq', value: true },
          { fact: 'resources.countable', op: 'gt', value: SNAP_FY2026.resourceLimitElderlyDisabled }] },
        { all: [{ fact: 'hh.elderly_or_disabled', op: 'eq', value: false },
          { fact: 'resources.countable', op: 'gt', value: SNAP_FY2026.resourceLimit }] },
      ] },
    ] },
  },
  {
    ruleId: 'cert.eligible', disposition: 'permit',
    legalAuthority: '7 CFR 273.9(a); 7 CFR 273.8(b); 7 CFR 273.2(f)(1)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'The grant. Mandatory verifications complete and every financial test met. The income tests here read percent-of-poverty facts the state engine derived, because the enumerated form does not fit twice inside the 64-node limit — the denial rules above carry the dollar figures.',
    rule: { all: [
      { fact: 'identity.verified', op: 'eq', value: true },
      { fact: 'residency.verified', op: 'eq', value: true },
      { fact: 'status.verified', op: 'eq', value: true },
      { any: [
        { fact: 'hh.categorically_eligible', op: 'eq', value: true },
        { all: [
          { any: [{ fact: 'hh.elderly_or_disabled', op: 'eq', value: true },
            { fact: 'income.gross_pct_fpl', op: 'lte', value: 130 }] },
          { fact: 'income.net_pct_fpl', op: 'lte', value: 100 },
          { any: [
            { all: [{ fact: 'hh.elderly_or_disabled', op: 'eq', value: true },
              { fact: 'resources.countable', op: 'lte', value: SNAP_FY2026.resourceLimitElderlyDisabled }] },
            { all: [{ fact: 'hh.elderly_or_disabled', op: 'eq', value: false },
              { fact: 'resources.countable', op: 'lte', value: SNAP_FY2026.resourceLimit }] },
          ] },
        ] },
      ] },
    ] },
  },
  {
    ruleId: 'cert.expedited', disposition: 'permit',
    legalAuthority: '7 CFR 273.2(i)(1)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'Expedited service within seven days. Criterion (iii) — income plus liquid resources less than shelter costs — is a sum the grammar cannot express and arrives as a derived fact (finding 1).',
    rule: { any: [
      { all: [{ fact: 'income.gross_monthly', op: 'lt', value: SNAP_FY2026.expedited.grossLt },
        { fact: 'resources.liquid', op: 'lte', value: SNAP_FY2026.expedited.liquidLte }] },
      { all: [{ fact: 'hh.destitute_migrant', op: 'eq', value: true },
        { fact: 'resources.liquid', op: 'lte', value: SNAP_FY2026.expedited.liquidLte }] },
      { fact: 'expedited.shelter_exceeds_means', op: 'eq', value: true },
    ] },
  },
  {
    ruleId: 'cert.interview_missed', disposition: 'bind',
    legalAuthority: '7 CFR 273.2(e)(3); 7 CFR 273.2(h)(1)(i)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'Procedural denial for a missed interview. interview.completed is a non-response fact guarded by the Notice of Missed Interview: it cannot be read until the NOMI reached the household.',
    rule: { fact: 'interview.completed', op: 'eq', value: false },
  },
  {
    ruleId: 'cert.verification_missing', disposition: 'bind',
    legalAuthority: '7 CFR 273.2(h)(1)(i); 7 CFR 273.2(c)(5)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'Procedural denial for verification not provided, guarded by delivery of the written statement of required verification.',
    rule: { fact: 'verification.provided', op: 'eq', value: false },
  },
  {
    ruleId: 'recert.not_returned', disposition: 'bind',
    legalAuthority: '7 CFR 273.14(b)(1); 7 CFR 273.14(b)(3)',
    effectiveFrom: SNAP_FY2026.effectiveFrom,
    note: 'Procedural termination at recertification, guarded by delivery of the notice of expiration.',
    rule: { fact: 'recert.returned', op: 'eq', value: false },
  },
  // The work requirement, as two versions of one rule: the age bound is the
  // literal H.R. 1 changed. A determination about a date before 1 Nov 2025
  // resolves to the first; one about a later date to the second.
  {
    ruleId: 'work.abawd_time_limit', disposition: 'bind',
    legalAuthority: '7 CFR 273.24 (pre-Pub. L. 119-21)',
    effectiveFrom: SNAP_FY2026.effectiveFrom, effectiveTo: SNAP_FY2026.abawd.after.effectiveFrom,
    note: 'Time limit for able-bodied adults without dependents, ages 18–54, three months in 36 without 80 hours a month.',
    rule: { all: [
      { fact: 'hh.age', op: 'gte', value: SNAP_FY2026.abawd.before.ageMin },
      { fact: 'hh.age', op: 'lte', value: SNAP_FY2026.abawd.before.ageMax },
      { fact: 'abawd.exempt', op: 'eq', value: false },
      { fact: 'abawd.hours_monthly', op: 'lt', value: SNAP_FY2026.abawd.hoursMonthly },
      { fact: 'abawd.months_used_36', op: 'gte', value: SNAP_FY2026.abawd.monthsIn36 },
    ] },
  },
  {
    ruleId: 'work.abawd_time_limit', disposition: 'bind',
    legalAuthority: '7 CFR 273.24 as amended by Pub. L. 119-21 §10102',
    effectiveFrom: SNAP_FY2026.abawd.after.effectiveFrom,
    note: 'The same limit, ages 18–64, with the veteran, homelessness and former-foster-youth exemptions repealed and the caregiver exemption narrowed to a child under 14 — all of which live in the derivation of abawd.exempt. TODO(legal-confirm) the effective date for the deployment.',
    rule: { all: [
      { fact: 'hh.age', op: 'gte', value: SNAP_FY2026.abawd.after.ageMin },
      { fact: 'hh.age', op: 'lte', value: SNAP_FY2026.abawd.after.ageMax },
      { fact: 'abawd.exempt', op: 'eq', value: false },
      { fact: 'abawd.hours_monthly', op: 'lt', value: SNAP_FY2026.abawd.hoursMonthly },
      { fact: 'abawd.months_used_36', op: 'gte', value: SNAP_FY2026.abawd.monthsIn36 },
    ] },
  },
];

/** The data dictionary. Descriptions are what the notice prints. */
export const SNAP_CATALOGUE: ReadonlyArray<{
  fact: string; factType: 'bool' | 'int' | 'str' | 'time'; class: 'plain' | 'delivery' | 'non_response';
  guardedBy?: string; description: string;
}> = [
  { fact: 'hh.size', factType: 'int', class: 'plain', description: 'Number of people in the SNAP household' },
  { fact: 'hh.age', factType: 'int', class: 'plain', description: 'Age of the individual, in years' },
  { fact: 'hh.elderly_or_disabled', factType: 'bool', class: 'plain', description: 'A member is 60 or older, or disabled' },
  { fact: 'hh.categorically_eligible', factType: 'bool', class: 'plain', description: 'Categorically eligible (7 CFR 273.2(j))' },
  { fact: 'hh.destitute_migrant', factType: 'bool', class: 'plain', description: 'Destitute migrant or seasonal farmworker household' },
  { fact: 'income.gross_monthly', factType: 'int', class: 'plain', description: 'Gross non-exempt monthly income, in dollars' },
  { fact: 'income.net_monthly', factType: 'int', class: 'plain', description: 'Net monthly income after deductions, in dollars (derived by the state benefit engine)' },
  { fact: 'income.gross_pct_fpl', factType: 'int', class: 'plain', description: 'Gross monthly income as a percent of the poverty line for the household size (derived)' },
  { fact: 'income.net_pct_fpl', factType: 'int', class: 'plain', description: 'Net monthly income as a percent of the poverty line for the household size (derived)' },
  { fact: 'resources.countable', factType: 'int', class: 'plain', description: 'Countable resources, in dollars' },
  { fact: 'resources.liquid', factType: 'int', class: 'plain', description: 'Liquid resources, in dollars' },
  { fact: 'expedited.shelter_exceeds_means', factType: 'bool', class: 'plain', description: 'Monthly rent or mortgage and utilities exceed gross income plus liquid resources (derived)' },
  { fact: 'identity.verified', factType: 'bool', class: 'plain', description: 'Identity verified' },
  { fact: 'residency.verified', factType: 'bool', class: 'plain', description: 'Residency verified' },
  { fact: 'status.verified', factType: 'bool', class: 'plain', description: 'Citizenship or immigration status verified' },
  { fact: 'abawd.exempt', factType: 'bool', class: 'plain', description: 'Exempt from the work requirement time limit' },
  { fact: 'abawd.hours_monthly', factType: 'int', class: 'plain', description: 'Hours worked or in a qualifying activity this month' },
  { fact: 'abawd.months_used_36', factType: 'int', class: 'plain', description: 'Months of benefits received without meeting the work requirement in the last 36' },
  // Deliveries, then what they guard.
  { fact: 'notice.interview.delivered_status', factType: 'str', class: 'delivery', description: 'Delivery of the Notice of Missed Interview' },
  { fact: 'notice.verification.delivered_status', factType: 'str', class: 'delivery', description: 'Delivery of the statement of required verification' },
  { fact: 'notice.recert.delivered_status', factType: 'str', class: 'delivery', description: 'Delivery of the notice of expiration' },
  { fact: 'interview.completed', factType: 'bool', class: 'non_response', guardedBy: 'notice.interview.delivered_status', description: 'The eligibility interview was completed' },
  { fact: 'verification.provided', factType: 'bool', class: 'non_response', guardedBy: 'notice.verification.delivered_status', description: 'Requested verification was provided' },
  { fact: 'recert.returned', factType: 'bool', class: 'non_response', guardedBy: 'notice.recert.delivered_status', description: 'The recertification application was returned' },
];

export const SNAP_SOURCES: ReadonlyArray<{ source: string; admissibility: 'self' | 'signed' | 'internal' | 'witness' | 'receipt' | 'authority'; programme: string; description: string }> = [
  { source: 'snap_case_system', admissibility: 'internal', programme: 'snap', description: 'The state SNAP eligibility system, including its benefit engine' },
  { source: 'caseworker', admissibility: 'internal', programme: 'snap', description: 'A caseworker, attesting under their own credential' },
  { source: 'state_wage_match', admissibility: 'authority', programme: 'snap', description: 'State wage records (7 CFR 273.2(f)(9) data match)' },
  { source: 'ssa_match', admissibility: 'authority', programme: 'ssa', description: 'Social Security Administration data match' },
  { source: 'medicaid_case_system', admissibility: 'internal', programme: 'medicaid', description: 'The state Medicaid eligibility system' },
  { source: 'usps_ncoa', admissibility: 'receipt', programme: 'snap', description: 'USPS returned mail and NCOA' },
  { source: 'applicant', admissibility: 'self', programme: 'snap', description: 'The household, on its application' },
];

/**
 * Apply the whole configuration to the principal's workspace. Idempotent:
 * every step is a declaration or a content-addressed commit, so a second
 * run changes nothing and reports `already_committed` for each rule.
 */
export async function seedSnap(p: Principal): Promise<{
  sources: number; facts: number; rules: RegisteredRule[]; committed: number; alreadyCommitted: number;
}> {
  await getPool().query(
    `INSERT INTO alias_types (workspace_id, alias_type, merge_strength) VALUES
       ($1,'ssn','strong'), ($1,'case_id','strong'), ($1,'email','medium'), ($1,'phone','medium')
     ON CONFLICT DO NOTHING`, [p.workspaceId]);
  for (const s of SNAP_SOURCES) await declareSource(p, s);
  for (const f of SNAP_CATALOGUE) {
    await catalogueFact(p, { fact: f.fact, factType: f.factType, class: f.class,
      guardedBy: f.guardedBy ?? null, description: f.description });
  }
  await declareRuleset(p, { ruleset: 'snap', exParteRule: null,
    description: 'SNAP certification, recertification and work requirement, FY 2026. No ex parte rule: 7 CFR 273.2(e)(2) requires the interview.' });
  const rules: RegisteredRule[] = [];
  let committed = 0, alreadyCommitted = 0;
  for (const r of SNAP_RULES) {
    const out = await commitRule(p, { ruleset: 'snap', ruleId: r.ruleId, rule: r.rule,
      legalAuthority: r.legalAuthority, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null,
      disposition: r.disposition, scope: 'snap', note: r.note });
    rules.push(out);
    if (out.outcome === 'committed') committed++; else alreadyCommitted++;
  }
  return { sources: SNAP_SOURCES.length, facts: SNAP_CATALOGUE.length, rules, committed, alreadyCommitted };
}
