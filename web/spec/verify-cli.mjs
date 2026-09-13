#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Verify a determination offline.
 *
 *   node spec/verify-cli.mjs record.json [--values values.json] [--keys keys.json]
 *
 * record.json  the record as exported by GET /v1/seals/:id
 * values.json  your own copy of the values: { "fact": { "type": "int", "value": 3 }, ... }
 * keys.json    the issuer's published keys, saved from /.well-known/crimp-keys.json
 *
 * No network, no dependencies, nothing from the issuer but the file you
 * saved. Exit 0 when every step that could run passed; 1 otherwise. A step
 * that could not run (no values, no key) is reported and does not fail.
 */
import { readFileSync } from 'node:fs';
import { verify } from './verifier.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!file) {
  console.error('usage: node spec/verify-cli.mjs record.json [--values values.json] [--keys keys.json] [--roots roots.json] [--require-pq]');
  process.exit(2);
}
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const det = read(file);
const held = opt('--values') ? read(opt('--values')) : {};
const keysFile = opt('--keys') ? read(opt('--keys')) : null;
const keys = keysFile === null ? undefined : (Array.isArray(keysFile) ? keysFile : keysFile.keys);

const rootsFile = opt('--roots') ? read(opt('--roots')) : null;
const roots = rootsFile === null ? undefined : (Array.isArray(rootsFile) ? rootsFile : rootsFile.roots);
const { steps, ok } = await verify(det, held, { keys, roots, requirePq: args.includes('--require-pq') });
for (const s of steps) {
  const mark = s.ok === true ? 'ok  ' : s.ok === false ? 'FAIL' : 'skip';
  console.log(`${mark}  ${s.step.padEnd(24)} ${s.detail}`);
}
console.log(ok ? '\nverified: every step that could run passed' : '\nNOT verified');
process.exit(ok ? 0 : 1);
