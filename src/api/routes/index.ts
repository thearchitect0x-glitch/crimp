// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import type { FastifyInstance } from 'fastify';
import { authorized } from '../app.js';
import {
  attestBody, sealBody, lookupBody, clawBody, cohortBody, placeBody, mergeBody,
  carveOutBody, mintKeyBody, windowQuery, errors, rulesetBody, ruleBody, closeRuleBody, catalogueBody,
  clockBody, findingsQuery, sourceBody, decisionBody,
} from '../schemas.js';
import {
  clawFromWire, factFromWire, sealToWire, lookupToWire,
  sourcesToWire, quadrantToWire, cliffsToWire, keyToWire,
  proofToWire, disclosureToWire, registeredRuleToWire, catalogueEntryToWire,
  clockToWire, timelinessToWire, findingToWire,
  type WireClaw, type WireFact,
} from '../serialize.js';
import { attest } from '../../domain/attest.js';
import { seal, lookup, exercise, claw } from '../../domain/seal.js';
import { sourceReliability, quadrant, cliffs } from '../../domain/insight.js';
import { declareCohort, placeInCohort } from '../../domain/cohort.js';
import { mergeSubjects, carveOut } from '../../domain/merge.js';
import { proof, disclosure, disclosures } from '../../domain/record.js';
import { declareRuleset, commitRule, closeRule, ruleHistory } from '../../domain/registry.js';
import { catalogueFact, listCatalogue, type FactClass } from '../../domain/catalogue.js';
import type { FactType } from '../../domain/rule.js';
import { startClock, clocksFor, timeliness } from '../../domain/clocks.js';
import { listFindings } from '../../domain/findings.js';
import { noticeFor } from '../../domain/notice.js';
import { harmLedger } from '../../domain/harm.js';
import { declareSource, listSources } from '../../domain/sources.js';
import { decide } from '../../domain/decisions.js';
import type { Admissibility } from '../../domain/admissibility.js';
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

/** Parse a timestamp where the message can name the field. */
function timestamp(raw: string | null | undefined, field: string): Date | null {
  if (raw == null) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(400, 'invalid_request', `"${raw}" is not a valid timestamp for ${field}.`);
  }
  return d;
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
    // NO SUBJECT ID. It is the join key, and returning it made this endpoint an
    // identity-linkage oracle: attest one alias, attest another, compare the
    // two responses, and an agent holding nothing but `attestations:write`
    // learns whether two identifiers belong to the same human being — which is
    // information the institution never chose to give it, for the price of two
    // writes.
    //
    // The proof export already withheld it, with a test asserting so and the
    // comment "a proof is about a determination, not a person". Those two
    // positions were incompatible and this was the open one. Nothing outside
    // this process needs the identifier: erasure is domain-internal, and every
    // caller identifies a subject by presenting aliases.
    return { count: out.count };
  });

  /* ── Seal ────────────────────────────────────────────────────────── */
  app.post<{
    Body: {
      idempotency_key: string; expires_at?: string | null;
      aliases: unknown; scope: string; disposition: 'bind' | 'permit' | 'commit';
      rule?: unknown; rule_ref?: { ruleset: string; rule_id: string }; as_of?: string | null;
      claw: WireClaw; max_uses?: number | null; required_facts?: string[];
    };
  }>('/seals', { schema: { body: sealBody, response: errors } }, async (req, reply) => {
    const p = await authorized(req, 'seals:write');
    const expiresAt = timestamp(req.body.expires_at, 'expires_at');
    const out = await seal(p, {
      idempotencyKey: req.body.idempotency_key,
      expiresAt,
      aliases: req.body.aliases,
      scope: req.body.scope,
      disposition: req.body.disposition,
      rule: req.body.rule,
      ruleRef: req.body.rule_ref === undefined ? null
        : { ruleset: req.body.rule_ref.ruleset, ruleId: req.body.rule_ref.rule_id },
      asOf: timestamp(req.body.as_of, 'as_of'),
      claw: clawFromWire(req.body.claw),
      maxUses: req.body.max_uses ?? null,
      requiredFacts: req.body.required_facts ?? [],
    }, await loadStrengths(p.workspaceId));
    // 201 only when a determination is newly created. A replay is 200: the
    // retry succeeded, but it did not create anything.
    reply.code(out.outcome === 'sealed' ? 201 : 200);
    return sealToWire(out);
  });

  /* ── Clocks and findings (cap-03) ────────────────────────────────── */
  app.post<{ Body: { aliases: unknown; scope: string; clock: string; started_at: string } }>(
    '/clocks', { schema: { body: clockBody, response: errors } }, async (req, reply) => {
      const p = await authorized(req, 'attestations:write');
      const startedAt = timestamp(req.body.started_at, 'started_at');
      if (startedAt === null) throw new ApiError(400, 'invalid_request', 'started_at is required.');
      const out = await startClock(p, {
        aliases: req.body.aliases, scope: req.body.scope, clock: req.body.clock, startedAt,
      }, await loadStrengths(p.workspaceId));
      reply.code(out.outcome === 'started' ? 201 : 200);
      return { outcome: out.outcome, ...clockToWire(out) };
    });

  // A read by aliases, like a lookup, and a POST for the same reason a
  // lookup is: the aliases are a body, not a URL.
  app.post<{ Body: { aliases: unknown } }>('/clocks/lookup', {
    schema: { body: { type: 'object', required: ['aliases'], additionalProperties: false,
      properties: { aliases: clockBody.properties.aliases } }, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'determinations:read');
    const rows = await clocksFor(p, { aliases: req.body.aliases }, await loadStrengths(p.workspaceId));
    return { clocks: rows.map(clockToWire) };
  });

  app.get<{ Querystring: { days?: string } }>('/insight/timeliness', {
    schema: { querystring: windowQuery, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'insight:read');
    return { clocks: (await timeliness(p, windowDays(req.query.days))).map(timelinessToWire) };
  });

  // cap-05. Days, never dollars: the record supports the first and not the second.
  app.get<{ Querystring: { days?: string } }>('/insight/harm', {
    schema: { querystring: windowQuery, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'insight:read');
    const rows = await harmLedger(p, windowDays(req.query.days, 365));
    return { ledger: rows.map((r) => ({
      programme: r.programme, rule: r.rule, month: r.month, reversals: r.reversals,
      days_without_coverage: r.daysWithoutCoverage, days_owed: r.daysOwed,
    })) };
  });

  app.get<{ Querystring: { class?: string; days?: string } }>('/findings', {
    schema: { querystring: findingsQuery, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'insight:read');
    const rows = await listFindings(p, { class: req.query.class, days: windowDays(req.query.days) });
    return { findings: rows.map(findingToWire) };
  });

  /* ── Sources (cap-07) ────────────────────────────────────────────── */
  app.post<{ Body: { source: string; admissibility: Admissibility; programme?: string | null; description?: string | null } }>(
    '/sources', { schema: { body: sourceBody, response: errors } }, async (req, reply) => {
      const p = await authorized(req, 'rules:write');
      const out = await declareSource(p, {
        source: req.body.source, admissibility: req.body.admissibility,
        programme: req.body.programme ?? null, description: req.body.description ?? null,
      });
      reply.code(201);
      return out;
    });

  app.get('/sources', { schema: { response: errors } }, async (req) => {
    const p = await authorized(req, 'rules:read');
    return { sources: await listSources(p) };
  });

  /* ── The catalogue (cap-01) ──────────────────────────────────────── */
  app.post<{
    Body: {
      fact: string; fact_type: FactType; class: FactClass; guarded_by?: string | null;
      guard_value?: string | null; allowed_values?: string[] | null; description?: string | null;
    };
  }>('/catalogue', { schema: { body: catalogueBody, response: errors } }, async (req, reply) => {
    const p = await authorized(req, 'rules:write');
    const out = await catalogueFact(p, {
      fact: req.body.fact, factType: req.body.fact_type, class: req.body.class,
      guardedBy: req.body.guarded_by ?? null, guardValue: req.body.guard_value ?? null,
      allowedValues: req.body.allowed_values ?? null, description: req.body.description ?? null,
    });
    reply.code(201);
    return catalogueEntryToWire(out);
  });

  app.get('/catalogue', { schema: { response: errors } }, async (req) => {
    const p = await authorized(req, 'rules:read');
    return { facts: (await listCatalogue(p)).map(catalogueEntryToWire) };
  });

  /* ── The registry (cap-08) ───────────────────────────────────────── */
  app.post<{ Body: { ruleset: string; description?: string | null; ex_parte_rule?: string | null } }>('/rulesets', {
    schema: { body: rulesetBody, response: errors },
  }, async (req, reply) => {
    const p = await authorized(req, 'rules:write');
    const out = await declareRuleset(p, {
      ruleset: req.body.ruleset, description: req.body.description ?? null,
      exParteRule: req.body.ex_parte_rule ?? null,
    });
    reply.code(201);
    return { ruleset: out.ruleset, ex_parte_rule: out.exParteRule };
  });

  app.post<{
    Params: { ruleset: string };
    Body: {
      rule_id: string; rule: unknown; legal_authority: string; effective_from: string;
      effective_to?: string | null; scope?: string | null; note?: string | null;
      disposition?: 'bind' | 'permit' | 'commit' | null;
    };
  }>('/rulesets/:ruleset/rules', {
    schema: { body: ruleBody, response: errors },
  }, async (req, reply) => {
    const p = await authorized(req, 'rules:write');
    const effectiveFrom = timestamp(req.body.effective_from, 'effective_from');
    if (effectiveFrom === null) {
      throw new ApiError(400, 'invalid_request', 'effective_from is required.');
    }
    const out = await commitRule(p, {
      ruleset: req.params.ruleset,
      ruleId: req.body.rule_id,
      rule: req.body.rule,
      legalAuthority: req.body.legal_authority,
      effectiveFrom,
      effectiveTo: timestamp(req.body.effective_to, 'effective_to'),
      scope: req.body.scope ?? null,
      note: req.body.note ?? null,
      disposition: req.body.disposition ?? null,
    });
    reply.code(out.outcome === 'committed' ? 201 : 200);
    return { outcome: out.outcome, ...registeredRuleToWire(out) };
  });

  // A POST with a verb, like /exercise: the one mutation a committed version
  // admits, and it is recorded with the actor's authority.
  app.post<{
    Params: { ruleset: string; rule_id: string; version: string };
    Body: { effective_to: string };
  }>('/rulesets/:ruleset/rules/:rule_id/:version/close', {
    schema: { body: closeRuleBody, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'rules:write');
    const effectiveTo = timestamp(req.body.effective_to, 'effective_to');
    if (effectiveTo === null) throw new ApiError(400, 'invalid_request', 'effective_to is required.');
    return registeredRuleToWire(await closeRule(p, {
      ruleset: req.params.ruleset, ruleId: req.params.rule_id,
      version: req.params.version, effectiveTo,
    }));
  });

  app.get<{ Params: { ruleset: string; rule_id: string } }>('/rulesets/:ruleset/rules/:rule_id', {
    schema: { response: errors },
  }, async (req) => {
    const p = await authorized(req, 'rules:read');
    const versions = await ruleHistory(p, req.params.ruleset, req.params.rule_id);
    return { versions: versions.map(registeredRuleToWire) };
  });

  /* ── A caseworker's decision (cap-10) ────────────────────────────── */
  app.post<{
    Body: {
      idempotency_key: string; aliases: unknown; scope: string; ruleset: string; rule_id: string;
      facts: WireFact[]; as_of?: string | null; expires_at?: string | null; claw?: WireClaw;
    };
  }>('/decisions', { schema: { body: decisionBody, response: errors } }, async (req, reply) => {
    const p = await authorized(req, 'seals:write');
    const out = await decide(p, {
      idempotencyKey: req.body.idempotency_key,
      aliases: req.body.aliases,
      scope: req.body.scope,
      ruleset: req.body.ruleset,
      ruleId: req.body.rule_id,
      facts: req.body.facts.map(factFromWire),
      asOf: timestamp(req.body.as_of, 'as_of'),
      expiresAt: timestamp(req.body.expires_at, 'expires_at'),
      claw: req.body.claw === undefined ? null : clawFromWire(req.body.claw),
    }, await loadStrengths(p.workspaceId));
    reply.code(out.outcome === 'sealed' ? 201 : 200);
    return { ...sealToWire(out), attested: out.attested, attester: out.attester };
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

  /* ── The record ──────────────────────────────────────────────────── */
  app.get<{ Params: { id: string } }>('/seals/:id', {
    schema: { response: errors },
  }, async (req) => {
    const p = await authorized(req, 'seals:read');
    return proofToWire(await proof(p, req.params.id));
  });

  // cap-04. The notice is derived from the record; with values it IS a
  // disclosure and is recorded as one, so it is a POST like the disclosure.
  app.post<{ Params: { id: string }; Querystring: { values?: string; language?: string; format?: string } }>(
    '/seals/:id/notice', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        values: { type: 'string', enum: ['true', 'false'] },
        language: { type: 'string', pattern: '^[a-z]{2}(-[A-Z]{2})?$' },
        format: { type: 'string', enum: ['json', 'text', 'html'] },
      } }, response: errors },
    }, async (req, reply) => {
      const p = await authorized(req, 'seals:read');
      const out = await noticeFor(p, req.params.id, {
        values: req.query.values === 'true',
        ...(req.query.language !== undefined ? { language: req.query.language } : {}),
      });
      if (req.query.format === 'text') return reply.type('text/plain; charset=utf-8').send(out.text);
      if (req.query.format === 'html') return reply.type('text/html; charset=utf-8').send(out.html);
      return { notice: out.notice, readability: out.readability, text: out.text, html: out.html };
    });

  // A POST, because it has a side effect: the disclosure is recorded. Nobody
  // anywhere currently records who asked why a person was refused, and for a
  // regulated buyer that record IS the compliance artifact.
  app.post<{ Params: { id: string } }>('/seals/:id/disclosure', {
    schema: { response: errors },
  }, async (req) => {
    const p = await authorized(req, 'seals:disclose');
    return disclosureToWire(await disclosure(p, req.params.id));
  });

  app.get<{ Querystring: { days?: string } }>('/insight/disclosures', {
    schema: { querystring: windowQuery, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'insight:read');
    const rows = await disclosures(p, windowDays(req.query.days));
    return { disclosures: rows.map((d) => ({
      seal_id: d.sealId, actor: d.actor, facts: d.facts,
      occurred_at: d.occurredAt.toISOString(),
    })) };
  });

  /* ── Claw ────────────────────────────────────────────────────────── */
  app.post<{
    Params: { id: string };
    Body: { evidence_sha256: string; evidence_class: string };
  }>('/seals/:id/claw', { schema: { body: clawBody, response: errors } }, async (req, reply) => {
    const p = await authorized(req, 'seals:claw');
    // A `pending` result is 202: the signature was accepted and the
    // determination is untouched until a second credential agrees.
    const out = await claw(p, {
      sealId: req.params.id,
      evidenceSha256: req.body.evidence_sha256,
      evidenceClass: req.body.evidence_class as never,
    });
    reply.code(out.state === 'pending' ? 202 : 200);
    return out.state === 'pending'
      ? { state: out.state, signatures_needed: out.signaturesNeeded }
      : { state: out.state };
  });

  /* ── Subjects: the merge, and its only correction ────────────────── */
  app.post<{ Body: { aliases: unknown; evidence_sha256: string; evidence_class: string } }>(
    '/subjects/merge', { schema: { body: mergeBody, response: errors } }, async (req) => {
      const p = await authorized(req, 'subjects:merge');
      const out = await mergeSubjects(p, {
        aliases: req.body.aliases,
        evidenceSha256: req.body.evidence_sha256,
        evidenceClass: req.body.evidence_class,
      }, await loadStrengths(p.workspaceId));
      // Always 200. A merge that found one subject created nothing, and a merge
      // that absorbed three destroyed rather than created — neither is a 201.
      return {
        subject_id: out.subjectId, outcome: out.outcome,
        absorbed: out.absorbed, alias_count: out.aliasCount,
      };
    });

  app.post<{
    Body: { alias: { type: string; value: string }; evidence_sha256: string; evidence_class: string };
  }>('/subjects/carve-out', {
    schema: { body: carveOutBody, response: errors },
  }, async (req) => {
    const p = await authorized(req, 'subjects:merge');
    const out = await carveOut(p, {
      alias: req.body.alias,
      evidenceSha256: req.body.evidence_sha256,
      evidenceClass: req.body.evidence_class,
    }, await loadStrengths(p.workspaceId));
    return { subject_id: out.subjectId, alias_count: out.aliasCount };
  });

  /* ── Cohorts: two ways in, no way out ────────────────────────────── */
  app.post<{ Body: { cohort: string; description?: string | null } }>('/cohorts', {
    schema: { body: cohortBody, response: errors },
  }, async (req, reply) => {
    const p = await authorized(req, 'cohorts:write');
    reply.code(201);
    return declareCohort(p, {
      cohort: req.body.cohort,
      description: req.body.description ?? null,
    });
  });

  app.post<{ Body: { aliases: unknown; cohort: string; band: string } }>('/cohorts/placements', {
    schema: { body: placeBody, response: errors },
  }, async (req, reply) => {
    const p = await authorized(req, 'cohorts:write');
    const out = await placeInCohort(p, {
      aliases: req.body.aliases,
      cohort: req.body.cohort,
      band: req.body.band,
    }, await loadStrengths(p.workspaceId));
    reply.code(201);
    // Neither the band nor the subject id. Echoing the band would make this a
    // read path for the value it exists to blind; echoing the subject id would
    // make it the same linkage oracle as attestation, reachable by anyone who
    // can place a cohort.
    return { placed: true };
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
