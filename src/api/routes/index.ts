// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import type { FastifyInstance } from 'fastify';
import { authorized } from '../app.js';
import {
  attestBody, sealBody, lookupBody, clawBody, mintKeyBody, windowQuery, errors,
} from '../schemas.js';
import {
  clawFromWire, factFromWire, sealToWire, lookupToWire,
  sourcesToWire, quadrantToWire, cliffsToWire, keyToWire,
  type WireClaw, type WireFact,
} from '../serialize.js';
import { attest } from '../../domain/attest.js';
import { seal, lookup, exercise, claw } from '../../domain/seal.js';
import { sourceReliability, quadrant, cliffs } from '../../domain/insight.js';
import { mintKey, revokeKey, type Scope } from '../../domain/auth.js';
import { getPool } from '../../db/pool.js';
import { loadStrengths } from '../../domain/strengths.js';
import { ApiError } from '../../lib/errors.js';

/** Parse and range-check a window, where the message can say what is wrong. */
function windowDays(raw: string | undefined, fallback = 90): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new ApiError(400, 'invalid_request',
      `"days" must be a whole number of days between 1 and 365; received ${JSON.stringify(raw)}.`,
      { days: raw });
  }
  return n;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* ── Attestation ─────────────────────────────────────────────────── */
  app.post<{ Body: { aliases: unknown; facts: WireFact[] } }>('/attestations', {
    schema: { body: attestBody, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'attestations:write');
    const out = await attest(p, {
      aliases: req.body.aliases,
      facts: req.body.facts.map(factFromWire),
    }, await loadStrengths(p.workspaceId));
    return { subject_id: out.subjectId, count: out.count };
  });

  /* ── Seal ────────────────────────────────────────────────────────── */
  app.post<{
    Body: {
      aliases: unknown; scope: string; disposition: 'bind' | 'permit' | 'commit';
      rule: unknown; claw: WireClaw; max_uses?: number | null; required_facts?: string[];
    };
  }>('/seals', { schema: { body: sealBody, response: errors } }, async (req, reply) => {
    const p = await authorized(req, 'seals:write');
    const out = await seal(p, {
      aliases: req.body.aliases,
      scope: req.body.scope,
      disposition: req.body.disposition,
      rule: req.body.rule,
      claw: clawFromWire(req.body.claw),
      maxUses: req.body.max_uses ?? null,
      requiredFacts: req.body.required_facts ?? [],
    }, await loadStrengths(p.workspaceId));
    // 201 when a determination now exists; 200 when the rule simply did not
    // hold, which is an answer rather than a failure.
    reply.code(out.outcome === 'sealed' ? 201 : 200);
    return sealToWire(out);
  });

  /* ── The hot path: a query ───────────────────────────────────────── */
  app.post<{ Body: { aliases: unknown; scope: string; session?: string } }>(
    '/determinations/lookup', { schema: { body: lookupBody, response: errors } }, async (req) => {
      const p = await authorized(req, 'determinations:read');
      return lookupToWire(await lookup(p, {
        aliases: req.body.aliases,
        scope: req.body.scope,
        ...(req.body.session !== undefined ? { session: req.body.session } : {}),
      }, await loadStrengths(p.workspaceId)));
    });

  // Spending a permit is a mutation and gets its own call. Asking a question
  // should never cost you the answer.
  app.post<{ Params: { id: string } }>('/seals/:id/exercise', {
    schema: { response: errors },
  }, async (req) => {
    const p = await authorized(req, 'permits:exercise');
    return exercise(p, { sealId: req.params.id });
  });

  /* ── Claw ────────────────────────────────────────────────────────── */
  app.post<{
    Params: { id: string };
    Body: { evidence_sha256: string; evidence_class: string };
  }>('/seals/:id/claw', { schema: { body: clawBody, response: errors } }, async (req) => {
    const p = await authorized(req, 'seals:claw');
    return claw(p, {
      sealId: req.params.id,
      evidenceSha256: req.body.evidence_sha256,
      evidenceClass: req.body.evidence_class as never,
    });
  });

  /* ── The measurements ────────────────────────────────────────────── */
  app.get<{ Querystring: { days?: string } }>('/insight/sources', {
    schema: { querystring: windowQuery, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'insight:read');
    const days = windowDays(req.query.days);
    return { sources: sourcesToWire(await sourceReliability(getPool(), p.workspaceId, days)) };
  });

  app.get<{ Querystring: { days?: string } }>('/insight/quadrant', {
    schema: { querystring: windowQuery, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'insight:read');
    return quadrantToWire(await quadrant(getPool(), p.workspaceId, windowDays(req.query.days)));
  });

  app.get('/insight/cliffs', { schema: { response: errors } }, async (req) => {
    const p = await authorized(req, 'insight:read');
    return { cliffs: cliffsToWire(await cliffs(getPool(), p.workspaceId)) };
  });

  /* ── Keys ────────────────────────────────────────────────────────── */
  app.post<{ Body: { authority: string; scopes: Scope[]; label: string } }>('/keys', {
    schema: { body: mintKeyBody, response: errors },
  }, async (req, reply) => {
    const p = await authorized(req, 'keys:mint');
    const out = await mintKey({
      workspaceId: p.workspaceId,
      authority: req.body.authority as never,
      scopes: req.body.scopes,
      label: req.body.label,
      by: p,
    });
    reply.code(201);
    return keyToWire(out);
  });

  app.delete<{ Params: { id: string } }>('/keys/:id', {
    schema: { response: errors },
  }, async (req, reply) => {
    // Revocation is deliberately NOT gated on `keys:mint`. A key must always be
    // able to revoke itself, including a narrow agent key that was never given
    // issuing rights — otherwise a leaked key cannot be retired by the thing
    // that noticed the leak.
    const { authenticate } = await import('../app.js');
    const p = await authenticate(req);
    await revokeKey(p, req.params.id);
    reply.code(204);
    return null;
  });
}
