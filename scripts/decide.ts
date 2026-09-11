// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-10 · The caseworker's CLI. One decision, from a JSON file, through
 * POST /v1/decisions — the same gate the API exposes and nothing more.
 *
 *   CRIMP_URL=https://crimp.example CRIMP_KEY=… npx tsx scripts/decide.ts decision.json
 *
 * The file is the request body: idempotency_key, aliases, scope, ruleset,
 * rule_id, facts (each with fact, type, value, source), optional as_of,
 * claw, expires_at. There is no field for an outcome, and a file that
 * carries one is refused by the server's schema, not by this script.
 */
import { readFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
const url = process.env['CRIMP_URL'];
const key = process.env['CRIMP_KEY'];
if (!file || !url || !key) {
  console.error('usage: CRIMP_URL=… CRIMP_KEY=… npx tsx scripts/decide.ts decision.json');
  process.exit(2);
}

const body = JSON.parse(readFileSync(file, 'utf8')) as unknown;
const res = await fetch(`${url.replace(/\/$/, '')}/v1/decisions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`${res.status}\n${text}`);
process.exit(res.ok ? 0 : 1);
