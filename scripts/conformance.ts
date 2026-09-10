// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Run the published conformance vectors against this implementation.
 *
 * The vectors in `spec/vectors/vectors.json` were derived from `docs/SPEC.md`
 * by an independent canonicaliser, deliberately not from this code. A
 * disagreement therefore means one of the two is wrong, and which one is a
 * question to answer rather than a number to adjust.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateRule, canonicalRule, type Rule, type Facts } from '../src/domain/rule.js';
import { evaluate } from '../src/domain/evaluate.js';
import { reasons } from '../src/domain/explain.js';
import { corrections } from '../src/domain/remedy.js';
import { Signer, verifyCore } from '../src/lib/signing.js';
import { canonicalize } from '../src/lib/ids.js';

const v = JSON.parse(readFileSync('spec/vectors/vectors.json', 'utf8')) as Record<string, never>;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

let pass = 0;
const fail: string[] = [];
const check = (group: string, name: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail.push(`  ${group} · ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

for (const c of v['canonical'] as unknown as Array<Record<string, never>>) {
  const canon = canonicalRule(c['rule'] as unknown as Rule);
  check('canonical', c['name'] as unknown as string, canon, c['canonical']);
  check('canonical', `${c['name'] as unknown as string} (hash)`, sha(canon), c['rule_sha256']);
}

for (const c of v['digest'] as unknown as Array<Record<string, never>>) {
  const got = sha(canonicalize({ t: c['fact_type'], v: c['value'] }));
  check('digest', c['name'] as unknown as string, got, c['value_sha256']);
}

for (const c of v['evaluate'] as unknown as Array<Record<string, never>>) {
  const got = evaluate(c['rule'] as unknown as Rule, c['facts'] as unknown as Facts);
  check('evaluate', c['name'] as unknown as string, got, c['truth']);
}

for (const c of v['reasons'] as unknown as Array<Record<string, never>>) {
  const got = reasons(c['rule'] as unknown as Rule, c['facts'] as unknown as Facts,
    c['truth'] as never)
    .map((r) => ({ path: r.path, fact: r.fact, truth: r.truth, polarity: r.polarity }));
  check('reasons', c['name'] as unknown as string, got, c['reasons']);
}

for (const c of v['refuse'] as unknown as Array<Record<string, never>>) {
  let refused = false;
  try { validateRule(c['rule']); } catch { refused = true; }
  check('refuse', c['name'] as unknown as string, refused, true);
}

// §3 — the rules the grammar must ADMIT. Refusal alone is easy to satisfy: a
// grammar that refuses everything passes every refuse vector.
for (const c of v['admit'] as unknown as Array<Record<string, never>>) {
  let admitted = true;
  try { validateRule(c['rule']); } catch { admitted = false; }
  check('admit', c['name'] as unknown as string, admitted, true);
}

// §7.0d — every minimal correction set, and nothing else, in a stated order.
for (const c of v['remedy'] as unknown as Array<Record<string, never>>) {
  const got = corrections(c['rule'] as unknown as Rule, c['facts'] as unknown as Facts, c['target'] as never);
  check('remedy', c['name'] as unknown as string,
    { exhaustive: got.exhaustive, sets: got.sets.map((set) => set.map((x) => ({
      fact: x.fact, fact_type: x.factType, constraints: x.constraints }))) },
    { exhaustive: c['exhaustive'], sets: c['sets'] });
}

// §7.0a — the one claim about a registered-rule snapshot a stranger can check.
// A record without the field is consistent by definition: the field is optional.
for (const c of v['record'] as unknown as Array<Record<string, never>>) {
  const rec = c['record'] as unknown as { rule: Rule; rule_hash: string; rule_ref?: { version: string } | null };
  const rh = sha(canonicalRule(rec.rule));
  check('record', `${c['name'] as unknown as string} (rule_hash)`, rh, rec.rule_hash);
  const consistent = rec.rule_ref == null ? true : rec.rule_ref.version === rh;
  check('record', c['name'] as unknown as string, consistent, c['rule_ref_consistent']);
}

// §7.0f — the signature: re-signed from the test seed (Ed25519 is
// deterministic) and verified over the core the vector carries.
const CORE = ['seal_id', 'scope', 'disposition', 'rule', 'rule_hash', 'grammar_version', 'sealed_by',
  'sealed_at', 'expires_at', 'as_of', 'rule_ref', 'reasons', 'facts', 'remedy'];
for (const c of v['signature'] as unknown as Array<Record<string, never>>) {
  const rec = c['record'] as unknown as Record<string, unknown>;
  const core = Object.fromEntries(CORE.map((k) => [k, rec[k] ?? null]));
  const sg = new Signer(c['test_seed_base64'] as unknown as string);
  const key = c['key'] as unknown as { kid: string; public_key: string };
  check('signature', `${c['name'] as unknown as string} (kid)`, sg.kid, key.kid);
  check('signature', c['name'] as unknown as string,
    verifyCore(core, rec['signature'] as never, key.public_key), c['valid']);
  if (c['valid']) check('signature', `${c['name'] as unknown as string} (deterministic)`, sg.signCore(core).sig,
    (rec['signature'] as { sig: string }).sig);
}

console.log(`conformance: ${pass} passed, ${fail.length} failed`);
if (fail.length > 0) {
  console.log('\n' + fail.join('\n\n'));
  process.exitCode = 1;
}
