// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Phase 2 · A Crimp record, projected onto the FHIR resources CMS-0057-F's
 * prior-authorization APIs carry: a `ClaimResponse` for the determination,
 * and a `Task` while it is pended or under review.
 *
 * READ-ONLY, and a PROJECTION. This module produces resources; it serves
 * nothing, stores nothing, and never reads FHIR in. It derives from the
 * notice (cap-04), which is itself a pure derivation of the record, so the
 * same record produces the same bundle forever.
 *
 * WHAT CMS-0057-F ASKS PAYERS TO EXPOSE (45 CFR 156.223, 42 CFR 422.121,
 * 431.80, 438.242, 457.732 — Patient Access API prior-authorization data):
 * the status, the date approved or denied, the date or circumstance under
 * which it ends, the items approved, and — if denied — a specific reason.
 * Every one of those has a home in ClaimResponse, and every one is a field
 * of the record already. What the record adds and FHIR has no base field
 * for — the rule's citation, the remedy, the clocks — travels as extensions
 * and process notes under Crimp's own canonical URL, so nothing is dropped
 * and nothing is disguised as something it is not.
 *
 * TODO(interop-confirm): field placement follows FHIR R4 base resources.
 * A payer's Da Vinci PAS / PDex profiles constrain further (required
 * codings, X12 reason codes, identifier systems) and must be applied by the
 * deployment on top of this projection. They are not guessed here.
 */
import type { Notice } from '../../domain/notice.js';
import { clauseText, remedyLines, LABELS_EN, type Labels } from '../../domain/notice.js';

export const CRIMP = 'https://crimp.deimoscore.com/fhir';
export const SYSTEMS = {
  reason: `${CRIMP}/CodeSystem/reason`,
  state: `${CRIMP}/CodeSystem/state`,
  record: `${CRIMP}/StructureDefinition/determination-record`,
  legalAuthority: `${CRIMP}/StructureDefinition/legal-authority`,
  ruleHash: `${CRIMP}/StructureDefinition/rule-hash`,
  remedy: `${CRIMP}/StructureDefinition/remedy`,
  clock: `${CRIMP}/StructureDefinition/clock`,
  underReview: `${CRIMP}/StructureDefinition/under-review`,
} as const;

const ADJUDICATION = 'http://terminology.hl7.org/CodeSystem/adjudication';

type Json = Record<string, unknown>;

/** FHIR ClaimResponse.outcome: queued | complete | error | partial. */
function outcomeOf(state: string): string {
  switch (state) {
    case 'sealed': case 'lapsed': case 'clawed': case 'expired': case 'exercised': return 'complete';
    case 'tainted': return 'partial';
    default: return 'queued';
  }
}

function reasonCoding(r: Notice['reasons'][number], L: Labels): Json {
  return {
    system: SYSTEMS.reason,
    code: `${r.path}:${r.fact}:${r.op}`,
    display: clauseText(r, L),
  };
}

export function toClaimResponse(n: Notice, L: Labels = LABELS_EN): Json {
  const denied = n.outcome.disposition === 'bind' && n.outcome.state === 'sealed';
  const extension: Json[] = [
    { url: SYSTEMS.record, valueString: n.sealId },
    { url: SYSTEMS.ruleHash, valueString: n.rule.ruleHash },
    ...(n.rule.legalAuthority ? [{ url: SYSTEMS.legalAuthority, valueString: n.rule.legalAuthority }] : []),
    ...(n.outcome.underReview ? [{ url: SYSTEMS.underReview, valueBoolean: true }] : []),
    ...n.clocks.map((c) => ({ url: SYSTEMS.clock, extension: [
      { url: 'name', valueString: c.clock }, { url: 'authority', valueString: c.authority },
      { url: 'status', valueCode: c.status }, { url: 'due', valueDateTime: c.dueAt },
    ] })),
  ];
  if (n.remedy && n.remedy.sets.length > 0) {
    extension.push({ url: SYSTEMS.remedy, valueString: JSON.stringify(n.remedy) });
  }
  const processNote: Json[] = [];
  if (n.remedy && n.remedy.sets.length > 0) {
    processNote.push({ number: 1, type: 'display', text: `${L.remedy}: ${remedyLines(n, L).join(` ${L.or} `)}` });
  }
  processNote.push({ number: processNote.length + 1, type: 'display', text: `${L.appeal}: ${n.appeal.text} ${L.appealBy} ${n.appeal.days} ${L.days}. ${L.authority}: ${n.appeal.authority}` });

  return {
    resourceType: 'ClaimResponse',
    id: n.sealId,
    meta: { source: `${CRIMP}/record/${n.sealId}` },
    extension,
    status: n.outcome.state === 'clawed' || n.outcome.state === 'expired' ? 'cancelled' : 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    use: 'preauthorization',
    created: n.outcome.sealedAt,
    outcome: outcomeOf(n.outcome.state),
    disposition: n.outcome.statement,
    ...(n.outcome.expiresAt ? { preAuthPeriod: { start: n.outcome.sealedAt, end: n.outcome.expiresAt } } : {}),
    item: [{
      itemSequence: 1,
      adjudication: [{
        category: { coding: [{ system: ADJUDICATION, code: denied ? 'benefit' : 'submitted' }],
          text: denied ? 'denied' : n.outcome.statement },
        ...(n.reasons.length > 0 ? { reason: { coding: n.reasons.map((r) => reasonCoding(r, L)),
          text: n.reasons.map((r) => clauseText(r, L)).join('; ') } } : {}),
      }],
    }],
    ...(processNote.length > 0 ? { processNote } : {}),
  };
}

/**
 * A Task while the determination is not final: pended on missing facts
 * (`tainted`), or under systemic review. Absent otherwise — a completed
 * determination is a ClaimResponse, not a task.
 */
export function toTask(n: Notice, L: Labels = LABELS_EN): Json | null {
  const pended = n.outcome.state === 'tainted';
  if (!pended && !n.outcome.underReview) return null;
  return {
    resourceType: 'Task',
    id: `${n.sealId}-review`,
    status: 'in-progress',
    intent: 'order',
    code: { coding: [{ system: SYSTEMS.state, code: pended ? 'tainted' : 'under_review' }],
      text: pended ? L.op['eq'] === undefined ? 'pended' : 'pended: facts no longer verifiable' : L.underReview },
    focus: { reference: `ClaimResponse/${n.sealId}` },
    authoredOn: n.outcome.sealedAt,
    input: [
      ...(n.rule.legalAuthority ? [{ type: { text: 'legal authority' }, valueString: n.rule.legalAuthority }] : []),
      { type: { text: 'rule hash' }, valueString: n.rule.ruleHash },
    ],
  };
}

/** A collection bundle: the ClaimResponse, and the Task if there is one. */
export function toBundle(n: Notice, L: Labels = LABELS_EN): Json {
  const entries: Json[] = [{ resource: toClaimResponse(n, L) }];
  const task = toTask(n, L);
  if (task) entries.push({ resource: task });
  return { resourceType: 'Bundle', type: 'collection', entry: entries };
}
