// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Declaring a fact source: its admissibility class, and (cap-07) which
 * programme's system it is.
 *
 * Until now sources were rows a setup script inserted. An institution that
 * wants to say "this feed is SNAP's case system" needs an API to say it in,
 * and the ex parte refusal (cap-07) needs the answer to name the programme
 * a fact came from — which is the whole point of that refusal.
 *
 * A declaration is an operator act, like the catalogue: a source's class is
 * what gives its facts weight, and an agent must not be able to promote the
 * feed it writes to.
 */
import { getPool } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { ADMISSIBILITY, type Admissibility } from './admissibility.js';
import { rankOf } from './authority.js';
import { requireScope, type Principal } from './auth.js';

const SOURCE = /^[a-z][a-z0-9_]{0,62}$/;
const PROGRAMME = /^[a-z][a-z0-9_]{0,30}$/;
export const SOURCE_AUTHORITY = 'operator';

export interface Source {
  source: string;
  admissibility: Admissibility;
  programme: string | null;
  description: string | null;
}

/**
 * Declare or re-declare. The admissibility class of an existing source is
 * FIXED here: attestations denormalise it at write time precisely so a later
 * change cannot reach back, and a live change would make the next
 * attestation from the same feed weigh differently from the last with no
 * event to say so. Declare a new source instead.
 */
export async function declareSource(p: Principal, args: {
  source: string; admissibility: Admissibility; programme?: string | null; description?: string | null;
}): Promise<Source> {
  requireScope(p, 'rules:write');
  if (rankOf(p.authority) < rankOf(SOURCE_AUTHORITY)) {
    throw new ApiError(403, 'insufficient_authority',
      `Declaring a source requires ${SOURCE_AUTHORITY} authority; this key is ${p.authority}.`,
      { required: SOURCE_AUTHORITY, held: p.authority });
  }
  if (typeof args.source !== 'string' || !SOURCE.test(args.source)) {
    throw new ApiError(400, 'invalid_request', `Source name ${JSON.stringify(args.source)} is not usable.`);
  }
  if (!(ADMISSIBILITY as readonly string[]).includes(args.admissibility)) {
    throw new ApiError(400, 'invalid_request', `admissibility must be one of: ${ADMISSIBILITY.join(', ')}.`);
  }
  const programme = args.programme ?? null;
  if (programme !== null && !PROGRAMME.test(programme)) {
    throw new ApiError(400, 'invalid_request', 'programme is one lowercase segment, like a scope\'s first segment.');
  }
  const pool = getPool();
  const { rows: prior } = await pool.query<{ admissibility: Admissibility }>(
    'SELECT admissibility FROM fact_sources WHERE workspace_id = $1 AND source = $2', [p.workspaceId, args.source]);
  if (prior[0] && prior[0].admissibility !== args.admissibility) {
    throw new ApiError(409, 'source_class_fixed',
      `"${args.source}" is declared ${prior[0].admissibility}. A source's class cannot change: declare a new source.`,
      { source: args.source, declared: prior[0].admissibility, requested: args.admissibility });
  }
  const { rows } = await pool.query<{ source: string; admissibility: Admissibility; programme: string | null; description: string | null }>(
    `INSERT INTO fact_sources (workspace_id, source, admissibility, programme, description)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, source) DO UPDATE SET
       programme = EXCLUDED.programme,
       description = coalesce(EXCLUDED.description, fact_sources.description)
     RETURNING source, admissibility, programme, description`,
    [p.workspaceId, args.source, args.admissibility, programme, args.description ?? null]);
  return rows[0]!;
}

export async function listSources(p: Principal): Promise<Source[]> {
  requireScope(p, 'rules:read');
  const { rows } = await getPool().query<Source>(
    'SELECT source, admissibility, programme, description FROM fact_sources WHERE workspace_id = $1 ORDER BY source',
    [p.workspaceId]);
  return rows;
}
