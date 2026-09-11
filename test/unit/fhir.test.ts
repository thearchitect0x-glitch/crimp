// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Phase 2 · The FHIR projection is a pure function of the notice, matches
 * its committed fixture byte for byte, and puts every CMS-0057-F element
 * where a ClaimResponse keeps it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toClaimResponse, toTask, toBundle, SYSTEMS } from '../../src/interop/fhir/map.js';
import { deriveNotice } from '../../src/domain/notice.js';
import type { Proof } from '../../src/domain/record.js';

const FIX = 'src/interop/fhir/fixtures';
const read = (f: string): unknown => JSON.parse(readFileSync(`${FIX}/${f}`, 'utf8'));

/** The reference refusal, as the notice tests build it. */
const proof = (over: Partial<Proof> = {}): Proof => ({
  sealId: 'seal_fixture', scope: 'prior_auth.imaging.mri', disposition: 'bind', state: 'sealed',
  rule: { all: [{ fact: 'clinical.conservative_therapy_weeks', op: 'lt', value: 6 },
    { fact: 'clinical.red_flag', op: 'eq', value: false }] },
  ruleHash: 'b'.repeat(64), grammarVersion: '1', sealedBy: 'agent',
  sealedAt: new Date('2026-09-01T12:00:00Z'), expiresAt: new Date('2026-12-01T00:00:00Z'), asOf: null,
  reviewFlaggedAt: null, signaturePq: null, signature: { kid: '56475aa75463474c', alg: 'ed25519', sig: 'AA==' },
  ruleRef: { ruleset: 'prior_auth', ruleId: 'imaging.mri_lumbar', version: 'b'.repeat(64),
    legalAuthority: '42 CFR 438.210(d)(1)', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null },
  remedy: { target: 'false', exhaustive: true, evaluations: 4, sets: [
    [{ fact: 'clinical.conservative_therapy_weeks', factType: 'int', constraints: [{ path: 'all[0]', op: 'lt', value: 6, truth: 'false' }] }],
    [{ fact: 'clinical.red_flag', factType: 'bool', constraints: [{ path: 'all[1]', op: 'eq', value: false, truth: 'false' }] }],
  ] },
  reasons: [
    { path: 'all[0]', fact: 'clinical.conservative_therapy_weeks', op: 'lt', value: 6, truth: 'true', polarity: 'direct' },
    { path: 'all[1]', fact: 'clinical.red_flag', op: 'eq', value: false, truth: 'true', polarity: 'direct' },
  ],
  facts: [
    { fact: 'clinical.conservative_therapy_weeks', factType: 'int', valueSha256: 'c'.repeat(64), source: 'ehr_feed',
      admissibility: 'internal', assertedAt: new Date('2026-08-30T00:00:00Z'), attester: 'key_1' },
    { fact: 'clinical.red_flag', factType: 'bool', valueSha256: 'd'.repeat(64), source: 'ehr_feed',
      admissibility: 'internal', assertedAt: new Date('2026-08-30T00:00:00Z'), attester: 'key_1' },
  ],
  events: [], verify: { ruleHash: '', valueDigest: '', ruleRef: '', signature: '', signaturePq: '', note: '' },
  ...over,
});
const catalogue = new Map([
  ['clinical.conservative_therapy_weeks', { fact: 'clinical.conservative_therapy_weeks', factType: 'int' as const, class: 'plain' as const,
    guardedBy: null, guardValue: null, allowedValues: null, description: 'Weeks of conservative therapy tried', declaredBy: 'operator', declaredAt: new Date() }],
  ['clinical.red_flag', { fact: 'clinical.red_flag', factType: 'bool' as const, class: 'plain' as const,
    guardedBy: null, guardValue: null, allowedValues: null, description: 'Red-flag symptom present', declaredBy: 'operator', declaredAt: new Date() }],
]);
const clocks = [{ clock: 'prior_auth_standard_7_day', authority: '42 CFR 438.210(d)(1); CMS-0057-F', status: 'met',
  startedAt: '2026-08-28T00:00:00.000Z', dueAt: '2026-09-04T00:00:00.000Z', metAt: '2026-09-01T12:00:00.000Z', missedAt: null }];

describe('the FHIR projection', () => {
  test('a denied prior authorization matches its fixture, byte for byte', () => {
    const n = deriveNotice({ proof: proof(), catalogue, clocks });
    const bundle = toBundle(n);
    assert.deepEqual(bundle, read('denial.bundle.json'));
    assert.equal(JSON.stringify(toBundle(deriveNotice({ proof: proof(), catalogue, clocks }))), JSON.stringify(bundle));
  });

  test('every CMS-0057-F element has a home', () => {
    const cr = toClaimResponse(deriveNotice({ proof: proof(), catalogue, clocks })) as Record<string, unknown>;
    assert.equal(cr['resourceType'], 'ClaimResponse');
    assert.equal(cr['use'], 'preauthorization');
    assert.equal(cr['status'], 'active');                                  // the status
    assert.equal(cr['created'], '2026-09-01T12:00:00.000Z');               // the date denied
    assert.deepEqual(cr['preAuthPeriod'], { start: '2026-09-01T12:00:00.000Z', end: '2026-12-01T00:00:00.000Z' }); // when it ends
    assert.equal(cr['disposition'], 'refused');
    const item = (cr['item'] as Array<{ adjudication: Array<{ reason: { coding: Array<{ system: string; code: string; display: string }>; text: string } }> }>)[0]!;
    const reason = item.adjudication[0]!.reason;                            // the specific reason
    assert.equal(reason.coding.length, 2);
    assert.equal(reason.coding[0]!.system, SYSTEMS.reason);
    assert.equal(reason.coding[0]!.display, 'Weeks of conservative therapy tried is less than 6');
    const ext = cr['extension'] as Array<{ url: string; valueString?: string }>;
    assert.equal(ext.find((e) => e.url === SYSTEMS.legalAuthority)?.valueString, '42 CFR 438.210(d)(1)');
    assert.equal(ext.find((e) => e.url === SYSTEMS.record)?.valueString, 'seal_fixture');
    assert.ok(ext.some((e) => e.url === SYSTEMS.clock));
    const notes = cr['processNote'] as Array<{ text: string }>;
    assert.match(notes[0]!.text, /^What would change this:/);
    assert.match(notes[1]!.text, /right to appeal/);
  });

  test('a completed determination has no Task; a pended or reviewed one does', () => {
    assert.equal(toTask(deriveNotice({ proof: proof(), catalogue })), null);
    const pended = toTask(deriveNotice({ proof: proof({ state: 'tainted' }), catalogue })) as Record<string, unknown>;
    assert.equal(pended['resourceType'], 'Task');
    assert.equal(pended['status'], 'in-progress');
    assert.deepEqual(pended['focus'], { reference: 'ClaimResponse/seal_fixture' });
    const reviewed = toTask(deriveNotice({ proof: proof({ reviewFlaggedAt: new Date('2026-09-05T00:00:00Z') }), catalogue }));
    assert.ok(reviewed);
    const cr = toClaimResponse(deriveNotice({ proof: proof({ state: 'tainted' }), catalogue })) as Record<string, unknown>;
    assert.equal(cr['outcome'], 'partial');
  });

  test('a reversal is a complete ClaimResponse that says so', () => {
    const cr = toClaimResponse(deriveNotice({ proof: proof({ state: 'lapsed' }), catalogue })) as Record<string, unknown>;
    assert.equal(cr['outcome'], 'complete');
    assert.equal(cr['disposition'], 'reversed');
  });
});
