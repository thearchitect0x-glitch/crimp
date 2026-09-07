// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Subject aliases: identifying a person without ever seeing who they are.
 *
 * Crimp holds determinations about people and must never hold the people. The
 * construction is Ratchet's, unchanged, because it was right there and it is
 * right here: only `HMAC(pepper, workspace|type|value)` is stored, truncated to
 * 128 bits. The value cannot be recovered from what is kept, and because the
 * workspace id is inside the MAC, the same card number in two workspaces
 * produces two unrelated identifiers — there is no cross-tenant correlation to
 * leak even accidentally.
 *
 * MERGE STRENGTH IS WHY THIS FILE IS NOT JUST A HASH.
 *
 * Aliases merge into a subject and merges are monotone — they may only ever add
 * bindings, never remove one. That closes the obvious evasion (a fresh email
 * still presenting a known card is dragged under the existing determination)
 * and opens a worse one: if merges can never be undone, a POISONING MERGE is a
 * denial of service that cannot be reversed. Present your own identifier
 * alongside a widely-shared one, force the union, and drag strangers under
 * somebody else's refusal.
 *
 * Strength is the first of three defences. Not all attributes are equal
 * evidence of identity, so only STRONG aliases may cause a union; weak ones can
 * carry a binding but never create one. The other two — a degree bound on
 * merges, and authority-signed carve-outs as the only correction — live with
 * the subject graph and the seal tables respectively.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './errors.js';
import { normalizeText } from './ids.js';

/**
 * How much identity evidence an alias type carries.
 *
 *   strong — may cause a merge. Bound to one person by an issuing authority or
 *            a payment network: a card fingerprint, a government identifier.
 *   medium — may cause a merge only when the workspace lowers the threshold.
 *            An email or phone: usually one person, routinely shared.
 *   weak   — may never cause a merge. A device, an IP, a household. These are
 *            shared by construction, and a merge on one unions strangers.
 */
export const MERGE_STRENGTHS = ['strong', 'medium', 'weak'] as const;
export type MergeStrength = (typeof MERGE_STRENGTHS)[number];

/**
 * Real people do not have four hundred email addresses. A subject that has
 * absorbed more components than this stops accepting merges and the attempt is
 * recorded — the refusal is a signal, not merely a guard.
 */
export const MAX_ALIASES_PER_SUBJECT = 64;

/** How many distinct existing subjects one alias may unify in a single merge. */
export const MAX_SUBJECTS_PER_MERGE = 4;

const ALIAS_TYPE = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_VALUE_LENGTH = 256;

export interface AliasInput {
  type: string;
  value: string;
}
export interface BlindedAlias {
  type: string;
  blinded: string;
  strength: MergeStrength;
}

/**
 * 128 bits of a peppered MAC.
 *
 * Truncated because this is a subject identifier, not a signature: a collision
 * would merge two people's determinations, and 2^-64 for that is far beyond
 * what this needs. Without the pepper the input is unrecoverable; with it, an
 * attacker already holds the secret and has larger problems.
 *
 * A separate secret from the one that protects API keys. A blinded value cannot
 * be re-derived — the input is gone by design — so rotating this pepper does
 * not invalidate a determination, it orphans one. That is a migration, not a
 * key rotation, and keeping the secrets separate keeps the two operations from
 * being confused for each other.
 */
export function blindAlias(workspaceId: string, type: string, value: string): string {
  return createHmac('sha256', config.blindSecret)
    .update(`alias:v1:${workspaceId}:${type}:${normalizeText(value)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Validate and blind a set of aliases.
 *
 * `strengths` is the workspace's declared classification of its own alias
 * types. An undeclared type is refused rather than defaulted: guessing that an
 * unknown identifier is weak makes it useless, and guessing it is strong makes
 * it a weapon.
 */
export function blindAliases(
  workspaceId: string,
  aliases: unknown,
  strengths: Readonly<Record<string, MergeStrength>>,
): BlindedAlias[] {
  if (!Array.isArray(aliases) || aliases.length === 0) {
    throw new ApiError(400, 'invalid_subject',
      'A subject must be identified by at least one alias.');
  }
  if (aliases.length > MAX_ALIASES_PER_SUBJECT) {
    throw new ApiError(400, 'invalid_subject',
      `At most ${MAX_ALIASES_PER_SUBJECT} aliases may be presented at once.`,
      { limit: MAX_ALIASES_PER_SUBJECT });
  }

  const seen = new Set<string>();
  const out: BlindedAlias[] = [];

  for (const raw of aliases as AliasInput[]) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ApiError(400, 'invalid_subject', 'Each alias must be an object of {type, value}.');
    }
    const { type, value } = raw;
    if (typeof type !== 'string' || !ALIAS_TYPE.test(type)) {
      throw new ApiError(400, 'invalid_subject',
        `Alias type ${JSON.stringify(type)} is not usable. Types are lowercase, start with a `
        + 'letter, and may contain letters, digits and underscores.', { type });
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
      throw new ApiError(400, 'invalid_subject',
        `Alias "${type}" must carry a string of 1 to ${MAX_VALUE_LENGTH} characters. `
        + 'Send the identifier itself — only a keyed hash of it is stored.', { type });
    }
    const strength = strengths[type];
    if (strength === undefined) {
      throw new ApiError(400, 'unknown_alias_type',
        `Alias type "${type}" has no declared merge strength in this workspace. Declare it `
        + 'before using it: an undeclared identifier is either useless or dangerous, and which '
        + 'one is not for Crimp to guess.', { type });
    }
    const blinded = blindAlias(workspaceId, type, value);
    const key = `${type}:${blinded}`;
    if (seen.has(key)) continue;  // presenting the same alias twice is not two aliases
    seen.add(key);
    out.push({ type, blinded, strength });
  }
  return out;
}

/** Aliases permitted to cause a union, given the workspace's declared threshold. */
export function mergeCapable(
  aliases: readonly BlindedAlias[],
  threshold: MergeStrength = 'strong',
): BlindedAlias[] {
  const rank: Record<MergeStrength, number> = { weak: 0, medium: 1, strong: 2 };
  const floor = rank[threshold];
  // `weak` is never merge-capable regardless of threshold. A workspace may not
  // configure its way into unioning strangers by device id.
  return aliases.filter((a) => a.strength !== 'weak' && rank[a.strength] >= floor);
}

/**
 * Does a caller-supplied value correspond to this stored alias?
 *
 * For the console and for reconciliation: an operator who knows the account
 * number can ask "is this the subject" without Crimp ever having held it.
 * Constant-time, because answering faster for a near-miss turns a lookup into
 * an oracle.
 */
export function aliasMatches(
  workspaceId: string, type: string, value: string, stored: string,
): boolean {
  const a = Buffer.from(blindAlias(workspaceId, type, value), 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A cohort band, blinded.
 *
 * Same construction as an alias and a deliberately different domain prefix, so
 * a band and an alias can never produce the same 128 bits. Without that
 * separation, "is this subject in band X" could be answered by presenting X as
 * an alias — a read path through the front door of a table that has no read
 * path by design.
 */
export function blindBand(workspaceId: string, cohort: string, band: string): string {
  return createHmac('sha256', config.blindSecret)
    .update(`cohort:v1:${workspaceId}:${cohort}:${normalizeText(band)}`)
    .digest('hex')
    .slice(0, 32);
}
