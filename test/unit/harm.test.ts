// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** cap-05 · Fixed dates in, fixed numbers out. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { harmOf, harmToStored } from '../../src/domain/harm.js';
import { RESTORATION } from '../../src/domain/restoration.config.js';

const D = (s: string) => new Date(s);

describe('harm arithmetic', () => {
  test('SNAP: 400 days refused, 365 owed — the 12-month window caps it', () => {
    const h = harmOf({ scope: 'snap.certification', sealedAt: D('2025-06-01T00:00:00Z'), reversedAt: D('2026-07-06T00:00:00Z') });
    assert.equal(h.daysWithoutCoverage, 400);
    assert.equal(h.daysOwed, 365);
    assert.equal(h.windowDays, 365);
    assert.equal(h.authority, '7 CFR 273.17(a)');
    assert.equal(RESTORATION['snap']?.windowDays, 365);
  });
  test('Medicaid: no window — corrective action reaches the action date', () => {
    const h = harmOf({ scope: 'medicaid.renewal', sealedAt: D('2025-06-01T00:00:00Z'), reversedAt: D('2026-07-06T00:00:00Z') });
    assert.equal(h.daysWithoutCoverage, 400);
    assert.equal(h.daysOwed, 400);
    assert.equal(h.windowDays, null);
    assert.equal(h.authority, '42 CFR 431.246');
  });
  test('inside the window, owed equals days', () => {
    const h = harmOf({ scope: 'snap', sealedAt: D('2026-01-01T00:00:00Z'), reversedAt: D('2026-01-31T00:00:00Z') });
    assert.equal(h.daysWithoutCoverage, 30);
    assert.equal(h.daysOwed, 30);
  });
  test('whole days, floored; never negative; same day is zero', () => {
    assert.equal(harmOf({ scope: 'snap', sealedAt: D('2026-01-01T00:00:00Z'), reversedAt: D('2026-01-02T23:59:00Z') }).daysWithoutCoverage, 1);
    assert.equal(harmOf({ scope: 'snap', sealedAt: D('2026-01-01T12:00:00Z'), reversedAt: D('2026-01-01T18:00:00Z') }).daysWithoutCoverage, 0);
    assert.equal(harmOf({ scope: 'snap', sealedAt: D('2026-01-02T00:00:00Z'), reversedAt: D('2026-01-01T00:00:00Z') }).daysWithoutCoverage, 0);
  });
  test('a programme with no restoration config still has its days counted, and says the cap is unknown', () => {
    const h = harmOf({ scope: 'lending.card', sealedAt: D('2026-01-01T00:00:00Z'), reversedAt: D('2026-03-01T00:00:00Z') });
    assert.equal(h.daysWithoutCoverage, 59);
    assert.equal(h.daysOwed, 59);
    assert.equal(h.windowDays, null);
    assert.equal(h.authority, null);
  });
  test('the stored shape is snake_case and carries both dates', () => {
    const h = harmToStored(harmOf({ scope: 'snap', sealedAt: D('2026-01-01T00:00:00Z'), reversedAt: D('2026-01-11T00:00:00Z') }));
    assert.deepEqual(h, { programme: 'snap', days_without_coverage: 10, days_owed: 10, window_days: 365,
      authority: '7 CFR 273.17(a)', refused_at: '2026-01-01T00:00:00.000Z', reversed_at: '2026-01-11T00:00:00.000Z' });
  });
});
