// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-01 · The fact catalogue, and the guard that makes delivery a
 * precondition to any finding of non-response.
 *
 * WHY THIS IS NOT A LIST OF WORDS. The brief says a rule referencing "failure
 * to respond", "did not return renewal", "or any non-response predicate" must
 * require a delivery fact. There is no list of words that captures "any
 * non-response predicate"; the next synonym defeats it. So the question is
 * inverted: the OPERATOR declares which facts are non-response facts, and the
 * declaration cannot be written without naming the delivery fact that guards
 * it. Once a workspace has a catalogue, a rule may name only catalogued facts,
 * so a synonym is not detected — it is impossible.
 *
 * WHY THE EVALUATOR DOES NOT CHANGE. A guarded fact whose guard does not hold
 * is withheld before evaluation. The evaluator receives fewer facts and
 * three-valued logic does the rest: "did not return the renewal" is UNKNOWN
 * until "the renewal reached them" is TRUE, and UNKNOWN cannot seal. No new
 * operator, no new value, no new rule the second implementation must learn.
 *
 * WHY THIS IS SAFE FOR THE RECORD. Strong Kleene evaluation is monotone in
 * information. A determination that evaluated TRUE with a fact withheld is
 * TRUE under every value of that fact, so an examiner who holds the value
 * re-runs the rule and reproduces the outcome. The format is untouched.
 */
import { getPool, type Db } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { FACT_TYPES, type FactType, type Facts, type Fact } from './rule.js';
import { rankOf } from './authority.js';
import { requireScope, type Principal } from './auth.js';

const FACT_NAME = /^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30}){0,3}$/;

export const CLASSES = ['plain', 'non_response', 'delivery'] as const;
export type FactClass = (typeof CLASSES)[number];

/**
 * What a delivery fact may say. `unknown` is a value, deliberately: "we sent
 * it and heard nothing" is a positive claim by a named source, which is the
 * only kind of absence this system admits.
 */
export const DELIVERED_STATUS = ['delivered', 'returned', 'unknown'] as const;
export const DELIVERED = 'delivered';

/** The channels the convention names. Validated where an operator catalogues a `.channel` fact with these as allowed values. */
export const CHANNELS = ['mail', 'e_notice', 'portal', 'sms'] as const;

/** Declaring what a fact IS is a policy act, like committing a rule. */
export const CATALOGUE_AUTHORITY = 'operator';

export interface CatalogueEntry {
  fact: string;
  factType: FactType;
  class: FactClass;
  guardedBy: string | null;
  guardValue: string | null;
  allowedValues: string[] | null;
  description: string | null;
  declaredBy: string;
  declaredAt: Date;
}

/** Empty means the workspace has not closed its facts; everything behaves as before. */
export type Catalogue = ReadonlyMap<string, CatalogueEntry>;

interface Row {
  fact: string; fact_type: FactType; class: FactClass; guarded_by: string | null;
  guard_value: string | null; allowed_values: string[] | null; description: string | null;
  declared_by: string; declared_at: Date;
}
const fromRow = (r: Row): CatalogueEntry => ({
  fact: r.fact, factType: r.fact_type, class: r.class, guardedBy: r.guarded_by,
  guardValue: r.guard_value, allowedValues: r.allowed_values, description: r.description,
  declaredBy: r.declared_by, declaredAt: r.declared_at,
});

export async function loadCatalogue(db: Db, workspaceId: string): Promise<Catalogue> {
  const { rows } = await db.query<Row>(
    `SELECT fact, fact_type, class, guarded_by, guard_value, allowed_values, description,
            declared_by, declared_at
       FROM fact_catalogue WHERE workspace_id = $1`, [workspaceId]);
  return new Map(rows.map((r) => [r.fact, fromRow(r)]));
}

export async function listCatalogue(p: Principal): Promise<CatalogueEntry[]> {
  requireScope(p, 'rules:read');
  return [...(await loadCatalogue(getPool(), p.workspaceId)).values()]
    .sort((a, b) => a.fact.localeCompare(b.fact));
}

/**
 * Declare a fact. Idempotent on re-declaration of class, guard, allowed values
 * and description; the TYPE of an existing entry is fixed, because changing
 * it would make every attestation already made under it unreadable.
 */
export async function catalogueFact(p: Principal, args: {
  fact: string;
  factType: FactType;
  class: FactClass;
  guardedBy?: string | null;
  guardValue?: string | null;
  allowedValues?: readonly string[] | null;
  description?: string | null;
}): Promise<CatalogueEntry> {
  requireScope(p, 'rules:write');
  if (rankOf(p.authority) < rankOf(CATALOGUE_AUTHORITY)) {
    throw new ApiError(403, 'insufficient_authority',
      `Declaring what a fact is requires ${CATALOGUE_AUTHORITY} authority; this key is ${p.authority}.`,
      { required: CATALOGUE_AUTHORITY, held: p.authority });
  }
  if (typeof args.fact !== 'string' || !FACT_NAME.test(args.fact)) {
    throw new ApiError(400, 'invalid_request', `Fact name ${JSON.stringify(args.fact)} is not usable.`);
  }
  if (!(FACT_TYPES as readonly string[]).includes(args.factType)) {
    throw new ApiError(400, 'invalid_request', `fact_type must be one of: ${FACT_TYPES.join(', ')}.`);
  }
  if (!(CLASSES as readonly string[]).includes(args.class)) {
    throw new ApiError(400, 'invalid_request', `class must be one of: ${CLASSES.join(', ')}.`);
  }

  let guardedBy = args.guardedBy ?? null;
  let guardValue = args.guardValue ?? null;
  let allowedValues = args.allowedValues == null ? null : [...args.allowedValues];

  if (args.class === 'non_response') {
    if (guardedBy === null) {
      throw new ApiError(400, 'guard_required',
        'A non-response fact must name the delivery fact that guards it. "They did not respond" '
        + 'is not a finding until "it reached them" is.', { fact: args.fact });
    }
    guardValue ??= DELIVERED;
  } else if (guardedBy !== null || args.guardValue != null) {
    throw new ApiError(400, 'invalid_request',
      `Only a non_response fact carries a guard; "${args.fact}" is ${args.class}.`);
  }

  if (args.class === 'delivery') {
    if (args.factType !== 'str') {
      throw new ApiError(400, 'invalid_request',
        `A delivery fact is a str carrying one of: ${DELIVERED_STATUS.join(', ')}.`);
    }
    allowedValues = [...DELIVERED_STATUS];
  }
  if (allowedValues !== null) {
    if (args.factType !== 'str') {
      throw new ApiError(400, 'invalid_request', 'allowed_values applies only to a str fact.');
    }
    if (allowedValues.length === 0 || allowedValues.length > 64
        || allowedValues.some((v) => typeof v !== 'string' || v.length === 0 || v.length > 64)) {
      throw new ApiError(400, 'invalid_request', 'allowed_values must be 1 to 64 non-empty strings.');
    }
    allowedValues = [...new Set(allowedValues)].sort();
  }

  const pool = getPool();
  const existing = await loadCatalogue(pool, p.workspaceId);
  const prior = existing.get(args.fact);
  if (prior !== undefined && prior.factType !== args.factType) {
    throw new ApiError(409, 'catalogue_type_fixed',
      `"${args.fact}" is catalogued as ${prior.factType}. A fact's type cannot change: every `
      + 'attestation already made under it would become unreadable.',
      { fact: args.fact, catalogued: prior.factType, requested: args.factType });
  }
  if (guardedBy !== null) {
    const guard = existing.get(guardedBy);
    if (guard === undefined || guard.class !== 'delivery') {
      throw new ApiError(400, 'guard_not_delivery',
        `"${guardedBy}" is not a catalogued delivery fact. Declare it with class "delivery" first.`,
        { fact: args.fact, guardedBy });
    }
    if (!(guard.allowedValues ?? []).includes(guardValue!)) {
      throw new ApiError(400, 'invalid_request',
        `guard_value must be one of: ${(guard.allowedValues ?? []).join(', ')}.`);
    }
  }

  const { rows } = await pool.query<Row>(
    `INSERT INTO fact_catalogue
       (workspace_id, fact, fact_type, class, guarded_by, guard_value, allowed_values,
        description, declared_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, fact) DO UPDATE SET
       class = EXCLUDED.class, guarded_by = EXCLUDED.guarded_by,
       guard_value = EXCLUDED.guard_value, allowed_values = EXCLUDED.allowed_values,
       description = EXCLUDED.description, declared_by = EXCLUDED.declared_by,
       declared_at = now()
     RETURNING fact, fact_type, class, guarded_by, guard_value, allowed_values, description,
               declared_by, declared_at`,
    [p.workspaceId, args.fact, args.factType, args.class, guardedBy, guardValue,
      allowedValues, args.description ?? null, p.authority]);
  return fromRow(rows[0]!);
}

/**
 * A closed catalogue admits only what it names. An open one admits anything —
 * which is every workspace until an operator declares the first fact.
 */
export function assertCatalogued(
  catalogue: Catalogue, facts: Iterable<string>, doing: string,
): void {
  if (catalogue.size === 0) return;
  const unknown = [...facts].filter((f) => !catalogue.has(f));
  if (unknown.length > 0) {
    throw new ApiError(400, 'uncatalogued_fact',
      `This workspace has a fact catalogue and ${doing} may name only facts in it. `
      + `Not catalogued: ${unknown.join(', ')}. A fact the programme never defined cannot `
      + 'decide about a person.', { uncatalogued: unknown });
  }
}

/** One attestation checked against the catalogue: type, and allowed values. */
export function assertAttestable(
  catalogue: Catalogue, fact: string, type: FactType, value: Fact['value'],
): void {
  const entry = catalogue.get(fact);
  if (entry === undefined) return;
  if (entry.factType !== type) {
    throw new ApiError(400, 'catalogue_type_mismatch',
      `"${fact}" is catalogued as ${entry.factType}; this attestation declares ${type}.`,
      { fact, catalogued: entry.factType, declared: type });
  }
  if (entry.allowedValues !== null && !entry.allowedValues.includes(value as string)) {
    throw new ApiError(400, 'value_not_allowed',
      `"${fact}" may carry one of: ${entry.allowedValues.join(', ')}.`,
      { fact, allowed: entry.allowedValues });
  }
}

/**
 * The guard facts a rule's facts depend on. A rule about non-response does
 * not name the delivery fact — that is the point — so the seal path must load
 * it on the rule's behalf, or every guard would read as "nothing attested".
 */
export function guardsOf(catalogue: Catalogue, referenced: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of referenced) {
    const g = catalogue.get(name)?.guardedBy;
    if (g != null) out.add(g);
  }
  return [...out];
}

export interface Withheld {
  fact: string;
  guardedBy: string;
  requires: string;
  /** What the guard fact says now, or null if nothing is attested. */
  observed: string | null;
  reason: 'delivery_unattested';
}

/**
 * Withhold every guarded fact whose guard does not hold.
 *
 * Pure. Returns the facts the evaluator may see and the list of what was
 * withheld and why — so the refusal can say "delivery_unattested" by name
 * rather than the caller inferring it from a missing fact.
 */
export function applyGuards(
  catalogue: Catalogue, facts: Facts, referenced: Iterable<string>,
): { facts: Facts; withheld: Withheld[] } {
  if (catalogue.size === 0) return { facts, withheld: [] };
  const withheld: Withheld[] = [];
  const names = new Set<string>();
  for (const name of referenced) {
    const entry = catalogue.get(name);
    if (entry === undefined || entry.guardedBy === null) continue;
    const guard = facts[entry.guardedBy];
    const observed = guard === undefined ? null : String(guard.value);
    if (observed === entry.guardValue) continue;
    names.add(name);
    withheld.push({
      fact: name, guardedBy: entry.guardedBy, requires: entry.guardValue!,
      observed, reason: 'delivery_unattested',
    });
  }
  if (names.size === 0) return { facts, withheld };
  // The evaluator's view is BUILT from what remains, never a copy with
  // rule-named keys deleted from it. `name` can only be a catalogued fact
  // here, so the old shape was safe; this one is safe by construction, and
  // the scanner (js/remote-property-injection) no longer has to be argued
  // with.
  const out: Facts = Object.fromEntries(Object.entries(facts).filter(([n]) => !names.has(n)));
  return { facts: out, withheld };
}
