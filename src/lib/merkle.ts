// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The Merkle tree of RFC 6962 (Certificate Transparency), over hex digests.
 *
 *   leaf hash  = sha256(0x00 || leaf bytes)
 *   node hash  = sha256(0x01 || left || right)
 *   MTH([])    = sha256('')
 *   split at the largest power of two strictly less than n
 *
 * Chosen because it is published, has two independent implementations in
 * every browser vendor's transparency log, and needs no padding rule. The
 * same construction is in spec/verifier.mjs so a stranger can walk a path.
 */
import { createHash } from 'node:crypto';

const sha = (parts: Buffer[]): Buffer => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const hex = (b: Buffer): string => b.toString('hex');
const bin = (h: string): Buffer => Buffer.from(h, 'hex');

export function leafHash(leafHex: string): string { return hex(sha([Buffer.from([0]), bin(leafHex)])); }
export function nodeHash(leftHex: string, rightHex: string): string { return hex(sha([Buffer.from([1]), bin(leftHex), bin(rightHex)])); }

function largestPowerOfTwoBelow(n: number): number { let k = 1; while (k * 2 < n) k *= 2; return k; }

/** Merkle tree hash over the leaves, in order. */
export function root(leavesHex: readonly string[]): string {
  const n = leavesHex.length;
  if (n === 0) return hex(sha([]));
  if (n === 1) return leafHash(leavesHex[0]!);
  const k = largestPowerOfTwoBelow(n);
  return nodeHash(root(leavesHex.slice(0, k)), root(leavesHex.slice(k)));
}

export interface PathStep { hash: string; side: 'left' | 'right' }

/** The audit path for leaf `index`: sibling hashes from the leaf up, each with the side it sits on. */
export function path(leavesHex: readonly string[], index: number): PathStep[] {
  const n = leavesHex.length;
  if (index < 0 || index >= n) throw new RangeError('leaf index out of range');
  if (n === 1) return [];
  const k = largestPowerOfTwoBelow(n);
  if (index < k) return [...path(leavesHex.slice(0, k), index), { hash: root(leavesHex.slice(k)), side: 'right' }];
  return [...path(leavesHex.slice(k), index - k), { hash: root(leavesHex.slice(0, k)), side: 'left' }];
}

/** Walk a path from a leaf to the root it claims. */
export function rootFromPath(leafHex: string, steps: readonly PathStep[]): string {
  let h = leafHash(leafHex);
  for (const s of steps) h = s.side === 'left' ? nodeHash(s.hash, h) : nodeHash(h, s.hash);
  return h;
}
