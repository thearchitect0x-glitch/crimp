// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  blindAlias, blindAliases, mergeCapable, aliasMatches,
  MAX_ALIASES_PER_SUBJECT,
  type MergeStrength,
} from '../../src/lib/blind.js';
import { assertProductionSafety } from '../../src/lib/config.js';
import { ApiError } from '../../src/lib/errors.js';

const strengths: Record<string, MergeStrength> = {
  card_fp: 'strong',
  gov_id: 'strong',
  email: 'medium',
  phone: 'medium',
  device: 'weak',
  ip: 'weak',
};

function refuses(fn: () => unknown, code: string, why: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError for ${why}, got ${String(e)}`);
    assert.equal(e.status, 400);
    assert.equal(e.code, code);
    return true;
  }, why);
}

describe('blinding', () => {
  test('is deterministic', () => {
    assert.equal(blindAlias('ws_1', 'email', 'a@b.com'), blindAlias('ws_1', 'email', 'a@b.com'));
  });

  test('is 128 bits of hex', () => {
    assert.match(blindAlias('ws_1', 'email', 'a@b.com'), /^[0-9a-f]{32}$/);
  });

  test('the same value in two workspaces is uncorrelatable', () => {
    assert.notEqual(
      blindAlias('ws_1', 'card_fp', '4242'),
      blindAlias('ws_2', 'card_fp', '4242'),
      'the workspace id is inside the MAC precisely so this holds',
    );
  });

  test('the same value under two alias types is uncorrelatable', () => {
    assert.notEqual(blindAlias('ws_1', 'email', 'x'), blindAlias('ws_1', 'phone', 'x'));
  });

  test('does not leak the input', () => {
    const secretish = 'SSN-078-05-1120';
    const b = blindAlias('ws_1', 'gov_id', secretish);
    assert.ok(!b.includes('078'), 'no substring of the input survives');
    assert.equal(b.length, 32);
  });

  test('normalises Unicode, so one identifier is one identifier', () => {
    // "café" composed vs decomposed — the same string, two legal encodings.
    assert.equal(
      blindAlias('ws_1', 'email', 'café@x.com'),
      blindAlias('ws_1', 'email', 'café@x.com'),
      'an agent on macOS and one on Linux must land on the same subject',
    );
  });
});

describe('alias validation', () => {
  test('accepts a well-formed set and reports strength', () => {
    const out = blindAliases('ws_1', [
      { type: 'card_fp', value: '4242' },
      { type: 'device', value: 'd-1' },
    ], strengths);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.strength, 'strong');
    assert.equal(out[1]?.strength, 'weak');
  });

  test('refuses an empty or non-array set', () => {
    refuses(() => blindAliases('ws_1', [], strengths), 'invalid_subject', 'empty');
    refuses(() => blindAliases('ws_1', {}, strengths), 'invalid_subject', 'not an array');
    refuses(() => blindAliases('ws_1', null, strengths), 'invalid_subject', 'null');
  });

  test('refuses malformed alias types and values', () => {
    for (const type of ['', 'Upper', '1x', 'has space', 'a-b']) {
      refuses(() => blindAliases('ws_1', [{ type, value: 'v' }], { ...strengths, [type]: 'strong' }),
        'invalid_subject', `type ${JSON.stringify(type)}`);
    }
    refuses(() => blindAliases('ws_1', [{ type: 'email', value: '' }], strengths),
      'invalid_subject', 'empty value');
    refuses(() => blindAliases('ws_1', [{ type: 'email', value: 'x'.repeat(257) }], strengths),
      'invalid_subject', 'over-long value');
    refuses(() => blindAliases('ws_1', ['nope'], strengths), 'invalid_subject', 'alias not an object');
  });

  test('refuses an undeclared alias type rather than guessing its strength', () => {
    refuses(() => blindAliases('ws_1', [{ type: 'browser_hash', value: 'x' }], strengths),
      'unknown_alias_type',
      'guessing weak makes it useless, guessing strong makes it a weapon');
  });

  test('refuses more aliases than a person could plausibly have', () => {
    const many = Array.from({ length: MAX_ALIASES_PER_SUBJECT + 1 },
      (_, i) => ({ type: 'email', value: `x${i}@y.com` }));
    refuses(() => blindAliases('ws_1', many, strengths), 'invalid_subject', 'too many aliases');
  });

  test('presenting the same alias twice is not two aliases', () => {
    const out = blindAliases('ws_1', [
      { type: 'email', value: 'a@b.com' },
      { type: 'email', value: 'a@b.com' },
    ], strengths);
    assert.equal(out.length, 1);
  });
});

describe('merge strength', () => {
  const aliases = blindAliases('ws_1', [
    { type: 'card_fp', value: '4242' },
    { type: 'email', value: 'a@b.com' },
    { type: 'device', value: 'd-1' },
  ], strengths);

  test('a weak alias can never cause a merge, at any threshold', () => {
    for (const threshold of ['strong', 'medium', 'weak'] as MergeStrength[]) {
      const capable = mergeCapable(aliases, threshold);
      assert.ok(!capable.some((a) => a.type === 'device'),
        `device became merge-capable at threshold ${threshold} — that unions strangers`);
    }
  });

  test('the default threshold admits only strong aliases', () => {
    assert.deepEqual(mergeCapable(aliases).map((a) => a.type), ['card_fp']);
  });

  test('lowering the threshold admits medium aliases', () => {
    assert.deepEqual(mergeCapable(aliases, 'medium').map((a) => a.type).sort(),
      ['card_fp', 'email']);
  });
});

describe('alias matching', () => {
  test('confirms a known value without Crimp having stored it', () => {
    const stored = blindAlias('ws_1', 'card_fp', '4242');
    assert.equal(aliasMatches('ws_1', 'card_fp', '4242', stored), true);
    assert.equal(aliasMatches('ws_1', 'card_fp', '4243', stored), false);
    assert.equal(aliasMatches('ws_2', 'card_fp', '4242', stored), false, 'wrong workspace');
    assert.equal(aliasMatches('ws_1', 'email', '4242', stored), false, 'wrong type');
  });

  test('a length mismatch is false rather than a throw', () => {
    assert.equal(aliasMatches('ws_1', 'card_fp', '4242', 'short'), false);
  });
});

describe('production safety', () => {
  const base = {
    nodeEnv: 'production', isProduction: true, port: 8788, databaseUrl: 'postgres://x',
    authSecret: 'a'.repeat(40), blindSecret: 'b'.repeat(40), corsOrigins: [] as string[],
  };
  type Cfg = Parameters<typeof assertProductionSafety>[0];

  test('permits a correctly configured production', () => {
    assertProductionSafety(base as unknown as Cfg);
  });

  test('never applies outside production', () => {
    assertProductionSafety({ ...base, nodeEnv: 'development', isProduction: false,
      authSecret: 'dev-secret-do-not-use-in-production' } as unknown as Cfg);
  });

  test('refuses the development secrets', () => {
    assert.throws(() => assertProductionSafety(
      { ...base, authSecret: 'dev-secret-do-not-use-in-production' } as unknown as Cfg), /AUTH_SECRET/);
    assert.throws(() => assertProductionSafety(
      { ...base, blindSecret: 'dev-secret-do-not-use-in-production' } as unknown as Cfg), /BLIND_SECRET/);
  });

  test('refuses short secrets and wildcard CORS', () => {
    assert.throws(() => assertProductionSafety({ ...base, authSecret: 'short' } as unknown as Cfg),
      /32 characters/);
    assert.throws(() => assertProductionSafety({ ...base, corsOrigins: ['*'] } as unknown as Cfg),
      /CORS_ORIGINS/);
  });

  test('refuses to let the two secrets be the same', () => {
    const same = 'c'.repeat(40);
    assert.throws(
      () => assertProductionSafety({ ...base, authSecret: same, blindSecret: same } as unknown as Cfg),
      /must differ/,
      'sharing them makes an auth rotation silently orphan every subject',
    );
  });
});
