// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Configuration, and the assertions that refuse to start without it.
 *
 * `assertProductionSafety` exists because a dangerous default is only dangerous
 * once it reaches production, and by then nobody is reading the README. Add a
 * check here whenever you add a setting that is safe in development and unsafe
 * outside it.
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ quiet: true });

const DEV_SECRET = 'dev-secret-do-not-use-in-production';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}.`);
}

export const config = {
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  get isProduction(): boolean { return this.nodeEnv === 'production'; },

  port: Number(process.env['PORT'] ?? 8788),
  databaseUrl: env('DATABASE_URL', 'postgres://crimp:crimp@localhost:5434/crimp'),

  /** Protects API keys. Rotating it must not invalidate customer keys. */
  authSecret: env('AUTH_SECRET', DEV_SECRET),

  /**
   * Peppers subject aliases. Deliberately a different secret from authSecret.
   *
   * A blinded alias cannot be re-derived — the input is gone by design — so
   * changing this does not rotate a key, it orphans every determination in the
   * system. Keeping the two secrets separate keeps that from being done by
   * accident during a routine auth rotation.
   */
  blindSecret: env('BLIND_SECRET', DEV_SECRET),

  corsOrigins: (process.env['CORS_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),

  /**
   * Signs every record's sealed core (SPEC §7.0f). The 32-byte Ed25519 seed,
   * base64. Read at use rather than at load so a test can set it. Absent in
   * development means records are unsigned and say so; absent in production
   * refuses to start — an unsigned record is internally consistent and
   * proves nothing about who issued it.
   */
  get signingKey(): string | null { return process.env['SIGNING_KEY'] || null; },

  dbPoolMax: Number(process.env['DB_POOL_MAX'] ?? 10),
  dbSsl: process.env['DB_SSL'] === 'true',
  statementTimeoutMs: Number(process.env['STATEMENT_TIMEOUT_MS'] ?? 10_000),
  idleInTxTimeoutMs: Number(process.env['IDLE_IN_TX_TIMEOUT_MS'] ?? 15_000),
} as const;

export function assertProductionSafety(cfg: typeof config = config): void {
  if (!cfg.isProduction) return;
  const fail: string[] = [];

  if (cfg.authSecret === DEV_SECRET) fail.push('AUTH_SECRET is the development default.');
  if (cfg.authSecret.length < 32) fail.push('AUTH_SECRET is shorter than 32 characters.');
  if (cfg.blindSecret === DEV_SECRET) fail.push('BLIND_SECRET is the development default.');
  if (cfg.blindSecret.length < 32) fail.push('BLIND_SECRET is shorter than 32 characters.');
  if (cfg.signingKey === null) fail.push('SIGNING_KEY is not set; records would be unsigned.');
  if (cfg.blindSecret === cfg.authSecret) {
    fail.push('BLIND_SECRET must differ from AUTH_SECRET — they have different rotation semantics '
      + 'and sharing them makes an auth rotation silently orphan every subject.');
  }
  if (cfg.corsOrigins.includes('*')) fail.push('CORS_ORIGINS contains "*".');

  if (fail.length > 0) {
    throw new Error(`Refusing to start in production:\n  - ${fail.join('\n  - ')}`);
  }
}
