// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-03 · The clocks a programme owes a person.
 *
 * Every number here is a federal default drawn from the rule it cites, and
 * every one is marked for legal confirmation. States may be tighter; a
 * deployment for one programme should confirm each against the operative
 * rule and the state plan before a finding is shown to anybody.
 *
 * A clock is NOT a fact a rule can read. A rule that could read "missed"
 * could turn the agency's lateness into the person's refusal, which is the
 * one thing the brief forbids in the same sentence it asks for clocks. Clocks
 * produce FINDINGS, addressed to the agency, and nothing else.
 */

export type MetBy =
  /** A determination sealed for the subject in (or around) the clock's scope. */
  | { kind: 'seal' }
  /** An attestation of the named fact for the subject, on or after the start. */
  | { kind: 'fact'; fact: string };

export interface ClockDefinition {
  /** The interval, in hours. Days are written as days × 24 so 72-hour clocks are not special. */
  hours: number;
  /** What must happen, on or before due, for the clock to be met. */
  metBy: MetBy;
  /** The provision that sets the interval. */
  authority: string;
  description: string;
}

const days = (n: number): number => n * 24;

export const CLOCKS: Readonly<Record<string, ClockDefinition>> = {
  // TODO(legal-confirm): 42 CFR 435.912(c)(3)(ii) — 45 days for applications
  // not on the basis of disability. Some states adopt shorter standards.
  application_45_day: {
    hours: days(45), metBy: { kind: 'seal' },
    authority: '42 CFR 435.912(c)(3)(ii)',
    description: 'Medicaid eligibility determination, application not on the basis of disability',
  },
  // TODO(legal-confirm): 42 CFR 435.912(c)(3)(i) — 90 days on the basis of disability.
  application_90_day_disability: {
    hours: days(90), metBy: { kind: 'seal' },
    authority: '42 CFR 435.912(c)(3)(i)',
    description: 'Medicaid eligibility determination, application on the basis of disability',
  },
  // TODO(legal-confirm): 7 CFR 273.2(g)(1) — 30 calendar days from the filing date.
  snap_30_day: {
    hours: days(30), metBy: { kind: 'seal' },
    authority: '7 CFR 273.2(g)(1)',
    description: 'SNAP: opportunity to participate within 30 days of application',
  },
  // TODO(legal-confirm): 7 CFR 273.2(i)(3)(i) — expedited service by the seventh calendar day.
  snap_expedited_7_day: {
    hours: days(7), metBy: { kind: 'seal' },
    authority: '7 CFR 273.2(i)(3)(i)',
    description: 'SNAP expedited service within 7 days of application',
  },
  // TODO(legal-confirm): 42 CFR 438.210(d)(1) as amended by CMS-0057-F — standard
  // prior authorization decisions within 7 calendar days (was 14). Confirm the
  // compliance date that applies to the payer.
  prior_auth_standard_7_day: {
    hours: days(7), metBy: { kind: 'seal' },
    authority: '42 CFR 438.210(d)(1); CMS-0057-F',
    description: 'Prior authorization, standard request: decision within 7 calendar days',
  },
  // TODO(legal-confirm): 42 CFR 438.210(d)(2) — expedited decisions within 72 hours.
  prior_auth_expedited_72_hour: {
    hours: 72, metBy: { kind: 'seal' },
    authority: '42 CFR 438.210(d)(2); CMS-0057-F',
    description: 'Prior authorization, expedited request: decision within 72 hours',
  },
  // TODO(legal-confirm): 42 CFR 431.244(f)(1) — final administrative action within
  // 90 days of the hearing request. Met by an adjudication being attested
  // (capability 6 defines the fact family; the name is fixed here so the two agree).
  fair_hearing_90_day: {
    hours: days(90), metBy: { kind: 'fact', fact: 'adjudication.ruling' },
    authority: '42 CFR 431.244(f)(1)',
    description: 'Fair hearing: final administrative action within 90 days of the request',
  },
};

export const CLOCK_NAMES = Object.keys(CLOCKS).sort();
