// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Entrypoint. Refuses to start on an unsafe production configuration, migrates,
 * then listens.
 *
 * Migrating on boot is safe with several instances starting at once: the
 * migration runner holds a transaction-scoped advisory lock, so the losers wait
 * and then find nothing left to do.
 */
import { buildApp } from './app.js';
import { config, assertProductionSafety } from '../lib/config.js';
import { migrate } from '../db/migrate.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { closePool } from '../db/pool.js';

assertProductionSafety();
assertRuntimeFiles();

const app = buildApp();

async function main(): Promise<void> {
  if (process.env['MIGRATE_ON_BOOT'] !== 'false') {
    const applied = await migrate((m) => app.log.info(m));
    app.log.info(`migrations up to date (${applied.length} applied)`);
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info(`${signal} received, draining`);
      await app.close();
      await closePool();
      process.exit(0);
    })();
  });
}

main().catch((err: unknown) => {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
});

/**
 * Two things are read from disk at request time and are not under dist/:
 * the format's home (`web/`, served at `/`) and the independent verifier
 * (`spec/verifier.mjs`, embedded in a person's copy). An image built without
 * them starts, answers /healthz, and then 404s the site and 500s the copy.
 * Refuse to start in production instead; warn elsewhere.
 */
function assertRuntimeFiles(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const missing = ['web/index.html', 'spec/verifier.mjs'].filter((f) => !existsSync(join(root, f)));
  if (missing.length === 0) return;
  const msg = `runtime files missing from this build: ${missing.join(', ')} - the Dockerfile must COPY web/ and spec/`;
  if (config.isProduction) { console.error(msg); process.exit(1); }
  console.warn(msg);
}
