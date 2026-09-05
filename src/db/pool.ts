// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import pg from 'pg';
import { config } from '../lib/config.js';

// BIGINT (OID 20) arrives as a string by default. Every bigint here is a
// counter that stays far inside Number.MAX_SAFE_INTEGER, so parsing to number
// keeps the domain layer readable without risking precision.
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      ssl: config.dbSsl ? { rejectUnauthorized: true } : undefined,
      application_name: 'crimp',
      // statement_timeout and idle_in_transaction_session_timeout are applied
      // per-transaction with SET LOCAL rather than as startup parameters:
      // `pg` sends startup parameters at connection time, and PgBouncer in
      // transaction-pooling mode — what sits in front of most managed
      // Postgres — rejects the connection outright with "unsupported startup
      // parameter". SET LOCAL is pooler-safe and equally effective.
    });
    pool.on('error', (err) => {
      // A pooled idle client died, e.g. the database restarted. Never crash
      // the process for this; the pool replaces it on next checkout.
      console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', err: err.message }));
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    // One round trip, not three. The simple-query protocol runs the whole
    // string in order; the SET LOCALs land inside the block BEGIN opened and
    // are released with it, so nothing leaks back into the pool.
    await client.query(
      'BEGIN; '
      + `SET LOCAL statement_timeout = ${config.statementTimeoutMs}; `
      + `SET LOCAL idle_in_transaction_session_timeout = ${config.idleInTxTimeoutMs}`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Postgres check-constraint violation — a schema invariant the code let through. */
export function isCheckViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23514';
}
