// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Prior authorization, as a Crimp programme: the sources, the catalogue,
 * the ruleset and the rules a payer would commit for one service line
 * (lumbar MRI), one drug policy (step therapy) and the procedural and
 * expedited paths, every criterion a literal with its citation.
 *
 * Built, like the SNAP configuration, to find where the format meets real
 * policy and where it does not. It found three things, recorded in
 * docs/programmes/prior_auth.md:
 *
 *   1. RESISTANCE ARRIVES AS AN APPEAL. In benefits, a person who is
 *      refused comes back and is refused again, and the gate counts it.
 *      In prior authorization nobody comes back that way: the member never
 *      looks up the determination, and the provider's portal session
 *      touches many members and is, correctly, excluded as wide. The
 *      quadrant was blind to the one signal this domain has, the appeal.
 *      Fixed: an appeal is now an event on the determination (appeal.ts)
 *      and counts as contestation.
 *   2. TIME AS THE ONLY REMEDY. "Conservative therapy for at least six
 *      weeks" is a criterion a member can satisfy only by waiting and
 *      being treated. The remedy names it truthfully; the mutability
 *      attribute (B4) needs a third kind, mutable by time, beside mutable
 *      by the person and fixed.
 *   3. THE DERIVED FACTS AGAIN. Weeks of conservative therapy and months
 *      since prior imaging are computed by the payer's claims engine from
 *      claims history; the record commits to the numbers, not to the
 *      computation (B3). The same finding as SNAP's, from a second
 *      programme, which is what makes it a property of the format rather
 *      than of one configuration.
 *
 * Every citation is TODO(legal-confirm): the compliance dates of
 * CMS-0057-F differ by payer type, Medicare Advantage and Medicaid managed
 * care regulate the same act under different sections, and the clinical
 * criteria are the plan's own, which 42 CFR 422.101(b)(6) requires to be
 * publicly accessible.
 */
import { getPool } from '../db/pool.js';
import type { Principal } from '../domain/auth.js';
import { catalogueFact } from '../domain/catalogue.js';
import { declareSource } from '../domain/sources.js';
import { declareRuleset, commitRule, type RegisteredRule } from '../domain/registry.js';
import type { Rule } from '../domain/rule.js';

export const PRIOR_AUTH = {
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  /** Weeks of conservative therapy before advanced imaging of the lumbar spine, absent red flags. Plan criterion. */
  conservativeTherapyWeeks: 6,
  /** Weeks of symptoms before advanced imaging, absent red flags. Plan criterion. */
  symptomDurationWeeks: 6,
  /** Months within which a repeat lumbar MRI is presumed duplicative, absent new red flags. Plan criterion. */
  repeatImagingMonths: 12,
} as const;

export const PRIOR_AUTH_RULES: ReadonlyArray<{
  ruleId: string; rule: Rule; legalAuthority: string; disposition: 'bind' | 'permit';
  effectiveFrom: Date; effectiveTo?: Date; note: string;
}> = [
  {
    ruleId: 'lumbar_mri.necessary', disposition: 'permit',
    legalAuthority: '42 CFR 422.101(b)(6); 42 CFR 438.210(a)(5)',
    effectiveFrom: PRIOR_AUTH.effectiveFrom,
    note: 'Lumbar MRI is authorised for an enrolled member with a red flag, a neurological deficit, or six weeks each of conservative therapy and symptoms. The criteria are the plan\'s own and must be publicly accessible (422.101(b)(6)).',
    rule: { all: [
      { fact: 'request.service', op: 'eq', value: 'lumbar_mri' },
      { fact: 'member.enrolled', op: 'eq', value: true },
      { any: [
        { fact: 'clinical.red_flag', op: 'eq', value: true },
        { fact: 'clinical.neuro_deficit', op: 'eq', value: true },
        { all: [
          { fact: 'clinical.conservative_therapy_weeks', op: 'gte', value: PRIOR_AUTH.conservativeTherapyWeeks },
          { fact: 'clinical.symptom_duration_weeks', op: 'gte', value: PRIOR_AUTH.symptomDurationWeeks },
        ] },
      ] },
    ] },
  },
  {
    ruleId: 'lumbar_mri.not_necessary', disposition: 'bind',
    legalAuthority: '42 CFR 422.101(b)(6); 42 CFR 438.210(a)(5)',
    effectiveFrom: PRIOR_AUTH.effectiveFrom,
    note: 'Denied: no red flag, no neurological deficit, and fewer than six weeks of conservative therapy or of symptoms. clinical.conservative_therapy_weeks is DERIVED by the claims engine — finding 3. The remedy it produces is satisfiable only by time and care — finding 2.',
    rule: { all: [
      { fact: 'request.service', op: 'eq', value: 'lumbar_mri' },
      { fact: 'clinical.red_flag', op: 'eq', value: false },
      { fact: 'clinical.neuro_deficit', op: 'eq', value: false },
      { any: [
        { fact: 'clinical.conservative_therapy_weeks', op: 'lt', value: PRIOR_AUTH.conservativeTherapyWeeks },
        { fact: 'clinical.symptom_duration_weeks', op: 'lt', value: PRIOR_AUTH.symptomDurationWeeks },
      ] },
    ] },
  },
  {
    ruleId: 'lumbar_mri.duplicate', disposition: 'bind',
    legalAuthority: '42 CFR 422.101(b)(6)',
    effectiveFrom: PRIOR_AUTH.effectiveFrom,
    note: 'Denied as duplicative: a lumbar MRI within the last twelve months and no new red flag. clinical.prior_imaging_months is DERIVED from claims history — finding 3.',
    rule: { all: [
      { fact: 'request.service', op: 'eq', value: 'lumbar_mri' },
      { fact: 'clinical.red_flag', op: 'eq', value: false },
      { fact: 'clinical.prior_imaging_months', op: 'lt', value: PRIOR_AUTH.repeatImagingMonths },
    ] },
  },
  {
    ruleId: 'step_therapy.required', disposition: 'bind',
    legalAuthority: '42 CFR 422.136',
    effectiveFrom: PRIOR_AUTH.effectiveFrom,
    note: 'Denied pending step therapy: a non-preferred drug, the preferred alternative not tried, and no documented exception. Medicare Advantage step therapy for Part B drugs; state law governs commercial plans.',
    rule: { all: [
      { fact: 'drug.tier', op: 'eq', value: 'non_preferred' },
      { fact: 'drug.preferred_alternative_tried', op: 'eq', value: false },
      { fact: 'drug.exception_documented', op: 'eq', value: false },
    ] },
  },
  {
    ruleId: 'procedural.information_not_returned', disposition: 'bind',
    legalAuthority: '42 CFR 422.568(b)(1); 42 CFR 438.210(d)(1)',
    effectiveFrom: PRIOR_AUTH.effectiveFrom,
    note: 'Denied for want of the additional information requested. A non-response fact: it is withheld until the request for information is attested delivered (cap-01), so a denial cannot rest on a request nobody received.',
    rule: { fact: 'provider.additional_info_returned', op: 'eq', value: false },
  },
  {
    ruleId: 'expedited.required', disposition: 'permit',
    legalAuthority: '42 CFR 422.570(c)(2); 42 CFR 438.210(d)(2)',
    effectiveFrom: PRIOR_AUTH.effectiveFrom,
    note: 'The request must be decided on the expedited clock: the provider attests that the standard timeframe could seriously jeopardise the member\'s life, health or ability to regain maximum function, or a red flag is present. The provider\'s attestation suffices by regulation.',
    rule: { all: [
      { fact: 'request.urgency', op: 'eq', value: 'expedited' },
      { any: [
        { fact: 'clinical.jeopardy_attested', op: 'eq', value: true },
        { fact: 'clinical.red_flag', op: 'eq', value: true },
      ] },
    ] },
  },
];

/** The data dictionary. Descriptions are what the notice prints. */
export const PRIOR_AUTH_CATALOGUE: ReadonlyArray<{
  fact: string; factType: 'bool' | 'int' | 'str' | 'time'; class: 'plain' | 'delivery' | 'non_response';
  guardedBy?: string; description: string;
}> = [
  { fact: 'request.service', factType: 'str', class: 'plain', description: 'The service requested (e.g. lumbar_mri)' },
  { fact: 'request.urgency', factType: 'str', class: 'plain', description: 'standard or expedited' },
  { fact: 'member.enrolled', factType: 'bool', class: 'plain', description: 'The member is enrolled on the date of service' },
  { fact: 'member.plan', factType: 'str', class: 'plain', description: 'The plan type: ma, medicaid_mco, commercial' },
  { fact: 'provider.in_network', factType: 'bool', class: 'plain', description: 'The requesting provider is in network' },
  { fact: 'clinical.red_flag', factType: 'bool', class: 'plain', description: 'A red flag is present (e.g. cauda equina, malignancy, infection, fracture)' },
  { fact: 'clinical.neuro_deficit', factType: 'bool', class: 'plain', description: 'A progressive neurological deficit is documented' },
  { fact: 'clinical.symptom_duration_weeks', factType: 'int', class: 'plain', description: 'Weeks of symptoms documented' },
  { fact: 'clinical.conservative_therapy_weeks', factType: 'int', class: 'plain', description: 'Weeks of conservative therapy (derived by the claims engine from paid claims)' },
  { fact: 'clinical.prior_imaging_months', factType: 'int', class: 'plain', description: 'Months since the last lumbar MRI (derived from claims history)' },
  { fact: 'clinical.jeopardy_attested', factType: 'bool', class: 'plain', description: 'The provider attests that the standard timeframe could seriously jeopardise the member' },
  { fact: 'drug.tier', factType: 'str', class: 'plain', description: 'The requested drug\'s formulary tier' },
  { fact: 'drug.preferred_alternative_tried', factType: 'bool', class: 'plain', description: 'The preferred alternative has been tried' },
  { fact: 'drug.exception_documented', factType: 'bool', class: 'plain', description: 'A documented exception to step therapy exists' },
  { fact: 'review.peer_to_peer_offered', factType: 'bool', class: 'plain', description: 'A peer-to-peer review was offered to the requesting provider' },
  { fact: 'notice.additional_info.delivered_status', factType: 'str', class: 'delivery', description: 'Whether the request for additional information reached the provider' },
  { fact: 'provider.additional_info_returned', factType: 'bool', class: 'non_response', guardedBy: 'notice.additional_info.delivered_status', description: 'The provider returned the additional information requested' },
];

export const PRIOR_AUTH_SOURCES: ReadonlyArray<{ source: string; admissibility: 'self' | 'signed' | 'internal' | 'witness' | 'receipt' | 'authority'; programme: string; description: string }> = [
  { source: 'utilization_management', admissibility: 'internal', programme: 'prior_auth', description: 'The payer\'s utilization-management system, including its criteria engine' },
  { source: 'medical_director', admissibility: 'internal', programme: 'prior_auth', description: 'A physician reviewer, attesting under their own credential' },
  { source: 'claims_history', admissibility: 'internal', programme: 'prior_auth', description: 'The payer\'s own paid-claims history: prior imaging, therapy visits' },
  { source: 'provider_portal', admissibility: 'signed', programme: 'prior_auth', description: 'The requesting provider on the authorization request: non-repudiable, and interested' },
  { source: 'ehr_records', admissibility: 'receipt', programme: 'prior_auth', description: 'Clinical records received from the provider\'s EHR' },
  { source: 'member', admissibility: 'self', programme: 'prior_auth', description: 'The member, on their own account' },
  { source: 'external_review', admissibility: 'authority', programme: 'prior_auth', description: 'An independent review entity or a state external review' },
  { source: 'mail_vendor', admissibility: 'receipt', programme: 'prior_auth', description: 'Notice delivery and returned mail' },
];

/** Apply the whole configuration to the principal's workspace. Idempotent, like seedSnap. */
export async function seedPriorAuth(p: Principal): Promise<{
  sources: number; facts: number; rules: RegisteredRule[]; committed: number; alreadyCommitted: number;
}> {
  await getPool().query(
    `INSERT INTO alias_types (workspace_id, alias_type, merge_strength) VALUES
       ($1,'member_id','strong'), ($1,'mbi','strong'), ($1,'email','medium'), ($1,'phone','medium')
     ON CONFLICT DO NOTHING`, [p.workspaceId]);
  for (const s of PRIOR_AUTH_SOURCES) await declareSource(p, s);
  for (const f of PRIOR_AUTH_CATALOGUE) {
    await catalogueFact(p, { fact: f.fact, factType: f.factType, class: f.class,
      guardedBy: f.guardedBy ?? null, description: f.description });
  }
  await declareRuleset(p, { ruleset: 'prior_auth', exParteRule: null,
    description: 'Prior authorization: lumbar MRI, step therapy, the procedural path and the expedited path. No ex parte rule: the merits here are the request itself.' });
  const rules: RegisteredRule[] = [];
  let committed = 0, alreadyCommitted = 0;
  for (const r of PRIOR_AUTH_RULES) {
    const out = await commitRule(p, { ruleset: 'prior_auth', ruleId: r.ruleId, rule: r.rule,
      legalAuthority: r.legalAuthority, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null,
      disposition: r.disposition, scope: 'prior_auth', note: r.note });
    rules.push(out);
    if (out.outcome === 'committed') committed++; else alreadyCommitted++;
  }
  return { sources: PRIOR_AUTH_SOURCES.length, facts: PRIOR_AUTH_CATALOGUE.length, rules, committed, alreadyCommitted };
}
