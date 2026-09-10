// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The join key does not leave the process.
 *
 * Crimp's whole subject design exists so it never holds a person: aliases are
 * blinded, the proof export withholds the subject id with a test asserting it,
 * and the comment there says "a proof is about a determination, not a person."
 *
 * Attestation returned it anyway. So an agent key holding nothing but
 * `attestations:write` could do this:
 *
 *     attest([card_A])  -> sub_9f2...
 *     attest([email_B]) -> sub_9f2...
 *
 * and learn that two identifiers belong to the same human being, for the price
 * of two writes, having been granted only the ability to write facts. Every
 * other part of the system was built to prevent exactly that.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { mintKey, SCOPES, AGENT_SCOPES } from '../../src/domain/auth.js';
import { freshWorkspace } from '../helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
before(async () => { await migrate(() => {}); app = await buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const FACTS = [{ fact: 'carrier.delivered', type: 'bool', value: false, source: 'carrier_api' }];

describe('an agent cannot link two identifiers', () => {
  test('attestation returns no identifier that can be compared across calls', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'narrow', by: null });

    // Two aliases that ARE the same person, presented separately. If either
    // response carried a comparable identifier the agent would learn it.
    const one = await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.key),
      payload: { aliases: [{ type: 'card_fp', value: 'same-human' }], facts: FACTS } });
    const two = await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.key),
      payload: { aliases: [{ type: 'card_fp', value: 'same-human' },
        { type: 'email', value: 'same-human@example.com' }], facts: FACTS } });

    assert.equal(one.statusCode, 200);
    assert.equal(two.statusCode, 200);
    for (const r of [one, two]) {
      const body = r.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['count'],
        'the response carries what was written and nothing that identifies whom');
    }
  });

  test('no response field anywhere matches the internal subject identifier', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'operator',
      scopes: [...SCOPES], label: 'op', by: null });
    const aliases = [{ type: 'card_fp', value: 'leak-probe' }];

    const bodies: string[] = [];
    bodies.push((await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.key), payload: { aliases, facts: FACTS } })).body);

    const d = await app.inject({ method: 'POST', url: '/v1/cohorts',
      headers: bearer(k.key), payload: { cohort: 'region' } });
    assert.equal(d.statusCode, 201);
    bodies.push((await app.inject({ method: 'POST', url: '/v1/cohorts/placements',
      headers: bearer(k.key),
      payload: { aliases, cohort: 'region', band: 'north' } })).body);

    // The identifier the system actually uses internally.
    const { rows } = await getPool().query<{ id: string }>(
      'SELECT id FROM subjects WHERE workspace_id = $1', [ws]);
    const subjectId = rows[0]!.id;
    assert.match(subjectId, /^sub_/);

    for (const body of bodies) {
      assert.equal(body.includes(subjectId), false,
        `the join key escaped in: ${body}`);
    }
  });

  test('the linkage that remains is inherent, and it is a refusal', async () => {
    const ws = await freshWorkspace();
    const k = await mintKey({ workspaceId: ws, authority: 'agent',
      scopes: [...AGENT_SCOPES], label: 'narrow', by: null });

    for (const v of ['person-one', 'person-two']) {
      await app.inject({ method: 'POST', url: '/v1/attestations', headers: bearer(k.key),
        payload: { aliases: [{ type: 'card_fp', value: v }], facts: FACTS } });
    }
    const both = await app.inject({ method: 'POST', url: '/v1/attestations',
      headers: bearer(k.key),
      payload: { aliases: [{ type: 'card_fp', value: 'person-one' },
        { type: 'card_fp', value: 'person-two' }], facts: FACTS } });

    // Presenting two aliases that belong to different people is refused, and
    // the refusal itself says they are different. That residual signal is not
    // removable: a gate that will not say what would lift it is a closed door
    // rather than a refusal. It is far weaker than the oracle above — it needs
    // the aliases to already conflict, it fails rather than succeeds, and it
    // tells the caller nothing it can act on alone. Stated in ASSURANCE_CASE §4
    // rather than papered over with a vaguer error.
    assert.equal(both.statusCode, 409);
    assert.equal(both.json().error.code, 'merge_required');
  });
});
