// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * OpenTimestamps, the minimum of it.
 *
 * A transparency root is a 32-byte digest. Anchoring it means getting a
 * public, independent party to commit to that digest at a date, so that a
 * record's inclusion proof ends in a value nobody could have chosen later.
 * OpenTimestamps calendars do that for free, and commit their aggregate
 * to Bitcoin within hours. The protocol needed here is one call: POST the
 * digest to `<calendar>/digest`, receive the calendar's timestamp for it.
 *
 * The detached proof file (`.ots`) that the reference client reads is:
 *
 *   magic (31 bytes) · version 1 · 0x08 (the file-hash op, SHA-256) ·
 *   the 32-byte digest · the calendar's timestamp bytes
 *
 * That is exactly what `ots stamp` writes, minus the random nonce the
 * reference client appends for privacy. A transparency root is public by
 * design, so the nonce buys nothing and its absence keeps the proof
 * reproducible from the root alone. `ots info`, `ots upgrade` and
 * `ots verify` accept the result unchanged.
 */

/** `\0OpenTimestamps\0\0Proof\0` followed by eight fixed bytes. */
export const OTS_MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
export const OTS_VERSION = 1;
export const OP_SHA256 = 0x08;

/** The public calendars the reference client uses. Any one is enough; several are cheap. */
export const CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
] as const;

/** A detached `.ots` for a SHA-256 digest, from the calendar's timestamp for that digest. */
export function detachedTimestamp(digestHex: string, calendarTimestamp: Buffer): Buffer {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error('digest must be 64 hex characters');
  return Buffer.concat([OTS_MAGIC, Buffer.from([OTS_VERSION, OP_SHA256]), Buffer.from(digestHex, 'hex'), calendarTimestamp]);
}

/** The header of a detached `.ots`, or a reason it is not one. */
export function parseDetached(ots: Buffer): { version: number; digestHex: string; timestamp: Buffer } {
  if (!ots.subarray(0, OTS_MAGIC.length).equals(OTS_MAGIC)) throw new Error('not an OpenTimestamps proof (magic)');
  const version = ots[OTS_MAGIC.length]!;
  const op = ots[OTS_MAGIC.length + 1];
  if (op !== OP_SHA256) throw new Error(`file-hash op 0x${op?.toString(16)} is not sha256`);
  const start = OTS_MAGIC.length + 2;
  return { version, digestHex: ots.subarray(start, start + 32).toString('hex'), timestamp: ots.subarray(start + 32) };
}

/** Ask one calendar to timestamp a digest. Returns its serialized timestamp for that digest. */
export async function submitDigest(calendar: string, digestHex: string, timeoutMs = 10_000): Promise<Buffer> {
  const res = await fetch(`${calendar}/digest`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'crimp-anchor/1' },
    body: Buffer.from(digestHex, 'hex'),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${calendar}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < 8) throw new Error(`${calendar}: empty timestamp`);
  return body;
}
