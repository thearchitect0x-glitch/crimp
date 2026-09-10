// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The app factory. Stateless, so it scales horizontally and is trivially
 * testable through `app.inject` without a socket.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import { verifyKey, requireScope, type Principal, type Scope } from '../domain/auth.js';
import { registerRoutes } from './routes/index.js';

declare module 'fastify' {
  interface FastifyRequest { principal?: Principal }
}

/**
 * Authenticate, or refuse.
 *
 * Key-only. There is no session, no cookie, and no browser path to any of
 * these routes — the whole surface performs or reads determinations, and a
 * determination made by something a CSRF could reach is not a determination.
 */
export async function authenticate(req: FastifyRequest): Promise<Principal> {
  const header = req.headers.authorization;
  const presented = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : undefined;
  const p = await verifyKey(presented);
  req.principal = p;
  return p;
}

export async function authorized(req: FastifyRequest, scope: Scope): Promise<Principal> {
  const p = await authenticate(req);
  requireScope(p, scope);
  return p;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? (config.nodeEnv === 'test' ? 'silent' : 'info'),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
    // A caller's typo is refused rather than silently dropped.
    //
    // allowUnionTypes is on for one schema that genuinely needs it: an attested
    // fact's `value` really can be a boolean, an integer or a string, because
    // the fact's declared `type` says which. Without this, ajv prints a
    // strict-mode warning on every boot that reads like a stack trace and sends
    // a newcomer looking for a failure that is not there. Found by the first
    // restore rehearsal.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allowUnionTypes: true } },
    bodyLimit: 256 * 1024,
    trustProxy: true,
  });

  void app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: false,
  });

  void app.register(rateLimit, {
    max: Number(process.env['RATE_LIMIT_MAX'] ?? 600),
    timeWindow: '1 minute',
    // Per key, not per IP: many agents behind one egress address are not each
    // other's neighbours, and rate-limiting them together makes one noisy
    // workspace throttle everybody else's.
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return typeof h === 'string' ? h.slice(-16) : (req.ip ?? 'anon');
    },
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (config.isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // Responses are per-key and must never be held by a shared proxy.
    if (req.url.startsWith('/v1')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status);
      return reply.send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.detail ? { detail: err.detail } : {}),
        },
      });
    }
    if ((err as { validation?: unknown }).validation) {
      reply.code(400);
      return reply.send({
        error: {
          code: 'invalid_request',
          message: (err as Error).message,
          detail: { validation: (err as { validation: unknown }).validation },
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      reply.code(500);
      // Internal detail never crosses this boundary. A request id, and nothing
      // that describes the shape of the system to whoever is probing it.
      return reply.send({
        error: { code: 'internal_error', message: 'Internal error.', detail: { request_id: req.id } },
      });
    }
    reply.code(status);
    return reply.send({ error: { code: 'request_error', message: (err as Error).message } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.url}.` },
    });
  });

  /**
   * LIVENESS. Is this process alive?
   *
   * It deliberately does NOT touch the database, and that is not laziness. A
   * liveness probe that checks a dependency turns a database outage into a
   * restart loop across every replica at once — the orchestrator kills healthy
   * processes for a fault they cannot fix by dying, and the stampede of
   * reconnects makes the outage worse. Liveness answers "should I be
   * restarted"; a dependency being down is never the answer to that.
   */
  app.get('/healthz', async () => ({ ok: true }));

  /**
   * READINESS. Should this instance receive traffic?
   *
   * This one must check the database, and it did not exist. `/healthz` returned
   * `{ ok: true }` unconditionally, so a container whose database was
   * unreachable reported itself healthy, was sent traffic, and returned 500 to
   * every request — the load balancer having been told, truthfully but
   * uselessly, that the process was running.
   *
   * It also reports pending migrations. During a rolling deploy an old
   * container coexists with a new schema, and a worker started with
   * MIGRATE_ON_BOOT=false can come up against a database nobody migrated.
   * Neither is visible to a probe that only asks whether the process is alive.
   */
  app.get('/readyz', async (_req, reply) => {
    const { getPool } = await import('../db/pool.js');
    const { pendingMigrations } = await import('../db/migrate.js');
    try {
      await getPool().query('SELECT 1');
      const pending = await pendingMigrations();
      if (pending.length > 0) {
        reply.code(503);
        return { ready: false, database: 'up', pending_migrations: pending };
      }
      return { ready: true, database: 'up', pending_migrations: [] };
    } catch {
      // No detail. A readiness probe is reachable from wherever the load
      // balancer is, and a connection string in its body is a gift.
      reply.code(503);
      return { ready: false, database: 'down' };
    }
  });

  /**
   * The keys records are signed under (SPEC §7.0f). No auth, no database: a
   * verifier fetches this once and keeps it. Empty when the deployment does
   * not sign, which production refuses to be.
   */
  app.get('/.well-known/crimp-keys.json', async (_req, reply) => {
    const { signer } = await import('../domain/signer.js');
    const sg = signer();
    reply.header('cache-control', 'public, max-age=3600');
    return { keys: sg === null ? [] : [sg.published()] };
  });

  void app.register(registerRoutes, { prefix: '/v1' });

  return app;
}
