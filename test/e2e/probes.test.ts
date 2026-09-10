// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Liveness and readiness are different questions, and only one of them existed.
 *
 * `/healthz` returned `{ ok: true }` unconditionally and never touched the
 * database. So a container whose database was unreachable reported itself
 * healthy, was sent traffic by the load balancer, and returned 500 to every
 * request — having answered, truthfully and uselessly, that the process was
 * running.
 *
 * The fix is not to make `/healthz` check the database. A LIVENESS probe that
 * checks a dependency turns an outage into a restart loop across every replica
 * at once: the orchestrator kills healthy processes for a fault they cannot
 * fix by dying, and the reconnect stampede makes the outage worse. Liveness
 * answers "should I be restarted"; a dependency being down is never the answer
 * to that. So the two probes are separate and answer different questions.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/api/app.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { migrate, pendingMigrations } from '../../src/db/migrate.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
before(async () => { await migrate(() => {}); app = await buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

describe('liveness', () => {
  test('answers without touching the database, and needs no credential', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });
  });
});

describe('readiness', () => {
  test('reports ready when the database is up and the schema is current', async () => {
    const r = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().ready, true);
    assert.equal(r.json().database, 'up');
    assert.deepEqual(r.json().pending_migrations, []);
  });

  test('refuses traffic while a migration is pending', async () => {
    // Exactly what a rolling deploy produces: an instance whose code expects a
    // schema the database has not reached, or a worker started with
    // MIGRATE_ON_BOOT=false against a database nobody migrated. Invisible to a
    // probe that only asks whether the process is alive.
    const { rows } = await getPool().query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
    const held = rows[0]!.name;
    await getPool().query('DELETE FROM schema_migrations WHERE name = $1', [held]);
    try {
      assert.deepEqual(await pendingMigrations(), [held]);
      const r = await app.inject({ method: 'GET', url: '/readyz' });
      assert.equal(r.statusCode, 503, 'a load balancer must not send traffic here');
      assert.equal(r.json().ready, false);
      assert.deepEqual(r.json().pending_migrations, [held]);
    } finally {
      await getPool().query('INSERT INTO schema_migrations (name) VALUES ($1)', [held]);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).json().ready, true);
  });

  test('says nothing useful to whoever can reach it', async () => {
    // A readiness probe is reachable from wherever the load balancer sits. Its
    // body must never carry a connection string, a host, or a driver error.
    const body = (await app.inject({ method: 'GET', url: '/readyz' })).body;
    for (const leak of ['postgres://', 'password', '5432', '5434', 'ECONNREFUSED']) {
      assert.equal(body.includes(leak), false, `readiness leaked "${leak}"`);
    }
  });
});
