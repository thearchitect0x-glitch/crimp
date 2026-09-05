// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
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
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
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

  app.get('/healthz', async () => ({ ok: true }));

  void app.register(registerRoutes, { prefix: '/v1' });

  return app;
}
