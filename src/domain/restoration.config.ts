// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-05 · What a programme restores when a refusal is reversed.
 *
 * Federal defaults, each marked for legal confirmation. Programme is the
 * first segment of the determination's scope, as for appeal rights.
 *
 * Restoration here is measured in DAYS OF COVERAGE, never in money. Crimp
 * holds no benefit amounts and does not compute them; a ledger of days is
 * what the record can support, and a dollar figure is the programme's to
 * attach from its own systems.
 */

export interface RestorationConfig {
  name: string;
  /**
   * The furthest back restoration reaches, in days, or null when the rule
   * restores to the date of the incorrect action however long ago.
   */
  windowDays: number | null;
  authority: string;
  note: string;
}

export const RESTORATION: Readonly<Record<string, RestorationConfig>> = {
  snap: {
    name: 'SNAP',
    // TODO(legal-confirm): 7 CFR 273.17(a) — lost benefits restored for up to
    // 12 months prior to the month the agency was notified or discovered the
    // loss. Twelve months taken as 365 days.
    windowDays: 365,
    authority: '7 CFR 273.17(a)',
    note: 'Lost benefits restored for up to 12 months before the loss was found.',
  },
  medicaid: {
    name: 'Medicaid',
    // TODO(legal-confirm): 42 CFR 431.246 — corrective action retroactive to
    // the date the incorrect action was taken. No window. (Retroactive
    // eligibility on application, 42 CFR 435.915, is a different provision
    // and is not modelled here.)
    windowDays: null,
    authority: '42 CFR 431.246',
    note: 'Corrective action reaches back to the date of the incorrect action.',
  },
  prior_auth: {
    name: 'Prior authorization',
    // TODO(legal-confirm): 42 CFR 438.424(a) — on reversal, the plan must
    // authorize or provide the disputed services promptly and no later than
    // 72 hours from the reversal. Restoration is the service itself; days
    // without it are still counted.
    windowDays: null,
    authority: '42 CFR 438.424(a)',
    note: 'Disputed services authorized or provided promptly after reversal.',
  },
};
