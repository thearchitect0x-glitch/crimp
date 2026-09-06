// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Admissibility: how much weight a piece of evidence carries.
 *
 * A PARTIAL order, not a ranking. Two classes are frequently incomparable, and
 * forcing them onto one scale invents a precision that is not there. The
 * deliberate gap is `internal` versus `witness`: an operator's own ledger and
 * an outside observer are wrong in different directions, and a system that
 * ranks them is guessing which failure it prefers.
 *
 * The rule the product actually needs falls straight out of the order: neither
 * `self` nor `signed` dominates `receipt` or `authority`, so a claw rule
 * demanding disinterested evidence CANNOT be satisfied by the party the
 * determination is against talking about itself. Signing proves non-repudiation,
 * not truth, and the order says so.
 *
 * This mirrors `admissibility_order` in migration 001. The duplication is
 * deliberate — validation must be answerable without a database round trip on
 * the hot path — and a test asserts the two agree, so they cannot drift.
 */
export const ADMISSIBILITY = [
  'self', 'signed', 'internal', 'witness', 'receipt', 'authority',
] as const;
export type Admissibility = (typeof ADMISSIBILITY)[number];

/** Direct edges: `key` dominates each of `value`. Transitive closure computed below. */
const EDGES: Record<Admissibility, readonly Admissibility[]> = {
  self: [],
  signed: ['self'],
  internal: ['signed'],
  witness: ['signed'],
  receipt: ['internal', 'witness'],
  authority: ['receipt'],
};

/** Reflexive-transitive closure, computed once at module load. */
const CLOSURE: Record<Admissibility, Set<Admissibility>> = (() => {
  const out = {} as Record<Admissibility, Set<Admissibility>>;
  for (const c of ADMISSIBILITY) out[c] = new Set<Admissibility>([c]);
  // The DAG is tiny and shallow; iterate to a fixed point rather than being clever.
  let changed = true;
  while (changed) {
    changed = false;
    for (const higher of ADMISSIBILITY) {
      for (const lower of EDGES[higher]) {
        for (const reach of out[lower]) {
          if (!out[higher].has(reach)) { out[higher].add(reach); changed = true; }
        }
      }
    }
  }
  return out;
})();

/** Does `higher` dominate `lower`? Reflexive: a class satisfies its own floor. */
export function dominates(higher: Admissibility, lower: Admissibility): boolean {
  return CLOSURE[higher]?.has(lower) ?? false;
}

/** Does this evidence meet the floor a claw rule declared? */
export function meetsFloor(evidence: Admissibility, floor: Admissibility): boolean {
  return dominates(evidence, floor);
}

/** Every pair in the closure, for the test that keeps this file and the migration in step. */
export function closurePairs(): Array<[Admissibility, Admissibility]> {
  const pairs: Array<[Admissibility, Admissibility]> = [];
  for (const higher of ADMISSIBILITY) {
    for (const lower of CLOSURE[higher]) pairs.push([higher, lower]);
  }
  return pairs.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
}

/**
 * The floor an agent's own word can never clear.
 *
 * Exported because it is the load-bearing consequence of this whole file, and
 * naming it makes the intent greppable from the seal path.
 */
export const DISINTERESTED: readonly Admissibility[] = ['receipt', 'authority'];

export function isSelfAsserted(c: Admissibility): boolean {
  return c === 'self' || c === 'signed';
}
