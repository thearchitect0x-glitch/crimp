// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * The detached proof we write is the one the reference client reads. The
 * fixture is a real calendar timestamp for sha256('crimp-ots-fixture'),
 * captured once; the layout test needs no network, and the reference-client
 * test runs only where `ots` is installed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OTS_MAGIC, OP_SHA256, detachedTimestamp, parseDetached } from '../../src/lib/ots.js';

const DIGEST = createHash('sha256').update('crimp-ots-fixture').digest('hex');
const fixture = readFileSync(new URL('../fixtures/sample.ots', import.meta.url));
const OTS_CLI = ['/Users/w0lfi3/Documents/Crimp-provisional/.venv/bin/ots', '/usr/local/bin/ots', '/opt/homebrew/bin/ots'].find((p) => existsSync(p));

describe('detached OpenTimestamps proofs', () => {
  test('the layout is magic, version 1, the sha256 op, the digest, then the calendar timestamp', () => {
    const { version, digestHex, timestamp } = parseDetached(fixture);
    assert.equal(version, 1);
    assert.equal(digestHex, DIGEST);
    assert.ok(timestamp.length > 8);
    assert.ok(fixture.subarray(0, OTS_MAGIC.length).equals(OTS_MAGIC));
    assert.equal(fixture[OTS_MAGIC.length + 1], OP_SHA256);
    // Rebuilding from the parts gives the same bytes.
    assert.ok(detachedTimestamp(digestHex, timestamp).equals(fixture));
  });

  test('a bad digest or a foreign file is refused', () => {
    assert.throws(() => detachedTimestamp('abc', Buffer.alloc(8)), /64 hex/);
    assert.throws(() => parseDetached(Buffer.from('not a proof')), /magic/);
  });

  test('the reference client reads what we write', { skip: OTS_CLI ? false : 'ots client not installed here' }, () => {
    const out = execFileSync(OTS_CLI!, ['info', new URL('../fixtures/sample.ots', import.meta.url).pathname], { encoding: 'utf8' });
    assert.match(out, new RegExp(`File sha256 hash: ${DIGEST}`));
    assert.match(out, /PendingAttestation|BitcoinBlockHeaderAttestation/);
  });
});
