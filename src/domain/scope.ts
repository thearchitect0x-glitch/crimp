// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Scopes: what a determination constrains.
 *
 * Dotted and hierarchical. A seal on `refund` covers `refund.issue.goodwill`,
 * because a refusal to refund that did not cover the ways of refunding would be
 * a refusal in name only.
 *
 * WHAT V1 DELIBERATELY DOES NOT MODEL, stated plainly because the omission is
 * load-bearing. Real scopes form a DAG, not a tree: `refund.issue` sits under
 * both `refund` and a cross-cutting `money.out`. A tree cannot express that, so
 * a seal on `money.out` will not, today, catch a refund.
 *
 * That is a real gap and it is chosen on purpose. Prefix containment is one
 * string comparison against a bounded ancestor set, which keeps the hot path a
 * single index scan; a general DAG needs a materialised closure and a
 * maintenance path for it. Shipping the tree first means every seal written
 * under it stays valid when the DAG lands — a DAG is a superset of a tree, so
 * widening later cannot change what an existing seal means. Widening is safe.
 * Narrowing would not be, which is why this is the order.
 */
import { ApiError } from '../lib/errors.js';

/** The universal scope. A seal on `*` covers everything in the workspace. */
export const ALL = '*';

export const MAX_SEGMENTS = 4;
const SEGMENT = /^[a-z][a-z0-9_]{0,30}$/;

export function validateScope(scope: unknown): string {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new ApiError(400, 'invalid_scope', 'A scope must be a non-empty string.');
  }
  if (scope === ALL) return scope;
  const parts = scope.split('.');
  if (parts.length > MAX_SEGMENTS) {
    throw new ApiError(400, 'invalid_scope',
      `A scope may have at most ${MAX_SEGMENTS} segments.`, { scope, limit: MAX_SEGMENTS });
  }
  for (const p of parts) {
    if (!SEGMENT.test(p)) {
      throw new ApiError(400, 'invalid_scope',
        `Scope segment ${JSON.stringify(p)} is not usable. Segments are lowercase, start with a `
        + 'letter, and may contain letters, digits and underscores.', { scope });
    }
  }
  return scope;
}

/**
 * Does a seal on `sealed` constrain an action in `query`?
 *
 * Containment runs one way only: the broader scope covers the narrower. A seal
 * on `refund.issue` does not constrain `refund`, because refusing one way of
 * refunding is not refusing all of them, and quietly widening it would let a
 * narrow determination bind actions nobody decided about.
 */
export function covers(sealed: string, query: string): boolean {
  if (sealed === ALL) return true;
  if (sealed === query) return true;
  return query.startsWith(`${sealed}.`);
}

/**
 * Every scope that could cover this one, broadest first.
 *
 * Bounded by MAX_SEGMENTS, so the hot-path lookup is `scope = ANY($1)` against
 * an array of at most five entries rather than a pattern match the planner
 * cannot use an index for.
 */
export function ancestors(query: string): string[] {
  const out: string[] = [ALL];
  if (query === ALL) return out;
  const parts = query.split('.');
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('.'));
  return out;
}
