// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-04 · What a notice must tell a person about their right to appeal,
 * per programme. Programme is the first segment of a determination's scope.
 *
 * Every number and every sentence here is a federal default marked for legal
 * confirmation. Appeal text is the one place in this codebase where prose
 * enters a record's derivation, and it is CONFIG — fixed, versioned, cited —
 * never generated. A notice for a programme with no entry here is refused
 * rather than issued without appeal rights.
 */

export interface AppealRights {
  /** The provision that grants the right and sets the window. */
  authority: string;
  /** Days from the notice date to request a hearing or reconsideration. */
  days: number;
  /**
   * Days within which a request keeps benefits in place pending the hearing,
   * where the programme provides that. Null where it does not.
   */
  continuedBenefitsDays: number | null;
  /** Fixed text. Version it here; do not generate it. */
  text: string;
}

export interface ProgrammeConfig {
  name: string;
  appeal: AppealRights;
}

export const PROGRAMMES: Readonly<Record<string, ProgrammeConfig>> = {
  medicaid: {
    name: 'Medicaid',
    appeal: {
      // TODO(legal-confirm): 42 CFR 431.221(d) — at least 90 days from the
      // notice date to request a fair hearing; 431.230(a) — benefits continue
      // if the request is made within the advance-notice period (before the
      // effective date). States may allow longer.
      authority: '42 CFR 431.221(d); 42 CFR 431.230',
      days: 90,
      continuedBenefitsDays: 10,
      text: 'You have the right to a fair hearing. You may ask for one within 90 days of the date '
        + 'of this notice. If you ask before the date this decision takes effect, your coverage '
        + 'may continue until the hearing decides. You may bring a lawyer, a relative, a friend, '
        + 'or another person to speak for you. You may see the file used to make this decision.',
    },
  },
  snap: {
    name: 'SNAP',
    appeal: {
      // TODO(legal-confirm): 7 CFR 273.15(g) — 90 days from the notice to
      // request a fair hearing; 273.15(k) — benefits continue if the request
      // is made within the advance-notice period.
      authority: '7 CFR 273.15(g); 7 CFR 273.15(k)',
      days: 90,
      continuedBenefitsDays: 10,
      text: 'You have the right to a fair hearing. You may ask for one within 90 days of the date '
        + 'of this notice, in person, in writing, or by phone. If you ask before the date this '
        + 'decision takes effect, your benefits may continue until the hearing decides. You may '
        + 'bring someone to help you at the hearing.',
    },
  },
  prior_auth: {
    name: 'Prior authorization',
    appeal: {
      // TODO(legal-confirm): 42 CFR 438.402(c)(2)(ii) — 60 days from the
      // adverse benefit determination to file an appeal with the plan
      // (Medicaid managed care). Medicare Advantage reconsideration windows
      // differ (42 CFR 422.582); confirm which applies to the payer.
      authority: '42 CFR 438.402(c)(2)(ii)',
      days: 60,
      continuedBenefitsDays: 10,
      text: 'You have the right to appeal this decision. You may file an appeal within 60 days of '
        + 'the date of this notice. You may ask for a fast appeal if waiting could seriously harm '
        + 'your health. You may ask to see the medical criteria used. If you appeal before the '
        + 'date this decision takes effect, your current services may continue during the appeal.',
    },
  },
};

export function programmeOf(scope: string): string {
  return scope === '*' ? '*' : scope.split('.')[0]!;
}
