// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Route schemas ARE the contract.
 *
 * Fastify validates against these and the OpenAPI document derives from them,
 * so a field that is not here does not exist — not in validation, not in the
 * published spec, and not in anybody's client.
 *
 * `additionalProperties: false` everywhere on bodies, with `removeAdditional`
 * off in the app factory, so a caller's typo is REFUSED rather than silently
 * dropped. Silently dropping is how somebody spends a week wondering why
 * `cooling_off_second` had no effect.
 *
 * Note what has no schema anywhere in this file: authority. There is no
 * `sealed_by`, no `actor`, no `workspace_id`. They come from the credential,
 * and a schema that accepted them would be the beginning of the end of that.
 */
import { ADMISSIBILITY } from '../domain/admissibility.js';
import { AUTHORITIES } from '../domain/authority.js';
import { SCOPES } from '../domain/auth.js';
import { FACT_TYPES } from '../domain/rule.js';

const error = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        detail: { type: 'object', additionalProperties: true },
      },
    },
  },
} as const;

export const errors = {
  400: error, 401: error, 403: error, 404: error, 409: error, 429: error, 500: error,
} as const;

const alias = {
  type: 'object',
  required: ['type', 'value'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', maxLength: 31 },
    value: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

const aliases = {
  type: 'array', minItems: 1, maxItems: 64, items: alias,
} as const;

/**
 * The rule is validated by `validateRule`, not by JSON Schema.
 *
 * A recursive schema could express the shape, but it could not express the
 * node-count bound, the vacuity refusal, or the operator/literal type pairing —
 * and two validators for one grammar is two things to keep in step. The schema
 * accepts an object and the grammar refuses everything wrong about it, with a
 * message that names the offending node.
 */
const rule = { type: 'object', additionalProperties: true } as const;

const claw = {
  type: 'object',
  required: ['authority', 'evidence_floor'],
  additionalProperties: false,
  properties: {
    authority: { type: 'string', enum: [...AUTHORITIES] },
    evidence_floor: { type: 'string', enum: [...ADMISSIBILITY] },
    cooling_off_seconds: { type: 'integer', minimum: 0, maximum: 7_776_000 },
  },
} as const;

export const attestBody = {
  type: 'object',
  required: ['aliases', 'facts'],
  additionalProperties: false,
  properties: {
    aliases,
    facts: {
      type: 'array', minItems: 1, maxItems: 64,
      items: {
        type: 'object',
        required: ['fact', 'type', 'value', 'source'],
        additionalProperties: false,
        properties: {
          fact: { type: 'string', maxLength: 96 },
          type: { type: 'string', enum: [...FACT_TYPES] },
          value: { type: ['boolean', 'integer', 'string'] },
          source: { type: 'string', maxLength: 63 },
          asserted_at: { type: 'string' },
          expires_at: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

export const sealBody = {
  type: 'object',
  required: ['aliases', 'scope', 'disposition', 'rule', 'claw'],
  additionalProperties: false,
  properties: {
    aliases,
    scope: { type: 'string', maxLength: 127 },
    disposition: { type: 'string', enum: ['bind', 'permit', 'commit'] },
    rule,
    claw,
    max_uses: { type: ['integer', 'null'], minimum: 1 },
    required_facts: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 96 } },
  },
} as const;

export const lookupBody = {
  type: 'object',
  required: ['aliases', 'scope'],
  additionalProperties: false,
  properties: {
    aliases,
    scope: { type: 'string', maxLength: 127 },
    // Caller-declared and blinded. A caller that lies only misleads itself:
    // these are the institution's own agents, and the count exists for its
    // own benefit. Recorded as a claim, not as a fact.
    session: { type: 'string', pattern: '^[0-9a-f]{32}$' },
  },
} as const;

export const clawBody = {
  type: 'object',
  required: ['evidence_sha256', 'evidence_class'],
  additionalProperties: false,
  properties: {
    // The commitment only. Crimp never holds the evidence itself.
    evidence_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    evidence_class: { type: 'string', enum: [...ADMISSIBILITY] },
  },
} as const;

export const mintKeyBody = {
  type: 'object',
  required: ['authority', 'scopes', 'label'],
  additionalProperties: false,
  properties: {
    authority: { type: 'string', enum: [...AUTHORITIES] },
    scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: [...SCOPES] } },
    label: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

/**
 * A querystring carries strings, and nothing else.
 *
 * The app factory sets `coerceTypes: false` so that a typo in a JSON body is
 * REFUSED rather than quietly reinterpreted — `"true"` becoming `true` is
 * exactly the kind of helpfulness that hides a bug for a week. But a query
 * parameter is a string by protocol, so declaring `days` an integer and then
 * refusing `?days=30` is not strictness, it is a broken endpoint.
 *
 * So the schema says what the wire actually carries, and `windowDays` below
 * does the conversion and the range check where a bad value can produce an
 * error message worth reading.
 */
export const windowQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { days: { type: 'string', pattern: '^[0-9]{1,3}$' } },
} as const;
