// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** Run the published vectors against the INDEPENDENT verifier in spec/verifier.mjs. */
import { readFileSync } from 'node:fs';
import { canonical, sha256, evaluate, reasons } from '../spec/verifier.mjs';

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

console.log(`independent verifier: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log('\n' + fail.join('\n\n')); process.exitCode = 1; }
