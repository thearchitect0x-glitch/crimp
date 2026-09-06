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
import { closePool } from '../db/pool.js';

assertProductionSafety();

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
