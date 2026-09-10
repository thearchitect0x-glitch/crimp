// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** Run the published vectors against the INDEPENDENT verifier in spec/verifier.mjs. */
import { readFileSync } from 'node:fs';
import { canonical, sha256, evaluate, reasons, verify } from '../spec/verifier.mjs';

const v = JSON.parse(readFileSync('spec/vectors/vectors.json', 'utf8'));
let pass = 0; const fail = [];
const check = (g, n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fail.push(`  ${g} · ${n}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

for (const c of v.canonical) {
  check('canonical', c.name, canonical(c.rule), c.canonical);
  check('canonical', `${c.name} (hash)`, await sha256(canonical(c.rule)), c.rule_sha256);
}
for (const c of v.digest) {
  check('digest', c.name, await sha256(canonical({ t: c.fact_type, v: c.value })), c.value_sha256);
}
for (const c of v.evaluate) check('evaluate', c.name, evaluate(c.rule, c.facts), c.truth);
for (const c of v.reasons) {
  check('reasons', c.name,
    reasons(c.rule, c.facts, c.truth).map((r) =>
      ({ path: r.path, fact: r.fact, truth: r.truth, polarity: r.polarity })), c.reasons);
}

// §7.0a, through the verifier's own procedure rather than a re-implementation
// of it: the 'rule ref' step must exist iff the field does, and agree.
for (const c of v.record) {
  const { steps } = await verify(c.record);
  const step = steps.find((s) => s.step === 'rule ref');
  const got = c.record.rule_ref == null ? step === undefined : step?.ok === true;
  check('record', c.name, got, c.rule_ref_consistent);
  check('record', `${c.name} (rule hash step)`, steps.find((s) => s.step === 'rule hash')?.ok, true);
}

// §7.0d — the verifier does not search; it checks that a remedy WORKS. Each
// vector's sets are run through `verify()` as a record whose values are held,
// which is exactly what an examiner with the institution's data would do.
for (const c of v.remedy) {
  const truth = evaluate(c.rule, c.facts);
  const facts = await Promise.all(Object.entries(c.facts).map(async ([fact, f]) => ({
    fact, fact_type: f.type, value_sha256: await sha256(canonical({ t: f.type, v: f.value })),
  })));
  const det = { grammar_version: '1', rule: c.rule, rule_hash: await sha256(canonical(c.rule)),
    state: truth === 'true' ? 'sealed' : truth === 'false' ? 'lapsed' : 'tainted',
    facts, reasons: [], remedy: { target: c.target, exhaustive: c.exhaustive, sets: c.sets } };
  const { steps } = await verify(det, c.facts);
  check('remedy', `${c.name} (effective)`, steps.find((s) => s.step === 'remedy · effective')?.ok, true);
}

// §7.0f — through verify() with the vector's published key.
for (const c of v.signature) {
  const { steps } = await verify(c.record, {}, { keys: [c.key] });
  check('signature', c.name, steps.find((s) => s.step === 'signature')?.ok, c.valid);
}

console.log(`independent verifier: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('\n' + fail.join('\n\n')); process.exitCode = 1; }
