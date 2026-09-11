// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * An independent verifier for the Determination Format.
 *
 * Written from docs/SPEC.md. It imports nothing from the Crimp implementation
 * and has no dependencies at all — it runs unchanged in Node and in a browser,
 * offline, with no account and no network.
 *
 * That independence is the point. A specification is only a standard if a
 * stranger can implement it from the text, and the only way to know whether
 * the text is sufficient is to write a second implementation and see whether
 * the two agree. This one passes the same published conformance vectors as the
 * reference implementation does.
 *
 * If this file and the reference disagree, at least one is wrong, and which is
 * a question to answer rather than a number to adjust.
 */

const TRUE = 'true', FALSE = 'false', UNKNOWN = 'unknown';

/* ── §5 · Canonical form ─────────────────────────────────────────────── */

export function canonical(node) {
  if (Array.isArray(node)) {
    // §5.4 — set members sorted AND de-duplicated. Multiplicity carries no
    // meaning in a set, so `in ["CA"]` and `in ["CA","CA"]` are one rule.
    const uniq = [...new Set(node.map((m) => JSON.stringify(m)))].sort();
    return `[${uniq.join(',')}]`;
  }
  if (node && typeof node === 'object') {
    for (const k of ['all', 'any']) {
      if (k in node) {
        // §5.3 — commutative, so children sort by their own canonical form.
        return `{"${k}":[${node[k].map(canonical).sort().join(',')}]}`;
      }
    }
    if ('not' in node) return `{"not":${canonical(node.not)}}`;
    return `{${Object.keys(node).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(node[k])}`).join(',')}}`;
  }
  // §5.6 — strings NFC-normalised. §5.5 — integers only, so no float format.
  if (typeof node === 'string') return JSON.stringify(node.normalize('NFC'));
  return JSON.stringify(node);
}

const enc = new TextEncoder();
export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const ruleHash = (rule) => sha256(canonical(rule));

/* ── §6 · Fact commitments ───────────────────────────────────────────── */

export const valueDigest = (factType, value) => sha256(canonical({ t: factType, v: value }));

/* ── §4 · Three-valued evaluation ────────────────────────────────────── */

const negate = (t) => (t === TRUE ? FALSE : t === FALSE ? TRUE : UNKNOWN);

export function evaluate(rule, facts) {
  if ('all' in rule) {
    const p = rule.all.map((r) => evaluate(r, facts));
    return p.includes(FALSE) ? FALSE : p.includes(UNKNOWN) ? UNKNOWN : TRUE;
  }
  if ('any' in rule) {
    const p = rule.any.map((r) => evaluate(r, facts));
    return p.includes(TRUE) ? TRUE : p.includes(UNKNOWN) ? UNKNOWN : FALSE;
  }
  if ('not' in rule) return negate(evaluate(rule.not, facts));

  const f = facts[rule.fact];
  // §4 — an absent or expired fact is UNKNOWN. Never false. This single line
  // is the difference between this format and a boolean one.
  if (f === undefined) return UNKNOWN;

  const norm = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);
  const left = norm(f.value);
  const lit = rule.value;
  const set = () => new Set((Array.isArray(lit) ? lit : []).map(norm));
  const t = (b) => (b ? TRUE : FALSE);

  switch (rule.op) {
    case 'eq': return t(left === norm(lit));
    case 'ne': return t(left !== norm(lit));
    case 'lt': return t(left < lit);
    case 'lte': return t(left <= lit);
    case 'gt': return t(left > lit);
    case 'gte': return t(left >= lit);
    case 'in': return t(set().has(left));
    case 'nin': return t(!set().has(left));
    default: throw new Error(`unknown operator: ${rule.op}`);
  }
}

/* ── §7.1 · Reasons ──────────────────────────────────────────────────── */

const join = (path, seg) => (path === '' ? seg : `${path}.${seg}`);

export function reasons(rule, facts, target) {
  const want = target ?? evaluate(rule, facts);
  return walk(rule, facts, want, '', false);
}

function walk(rule, facts, want, path, negated) {
  for (const kind of ['all', 'any']) {
    if (kind in rule) {
      const deciding = kind === 'all' ? FALSE : TRUE;
      const out = [];
      rule[kind].forEach((child, i) => {
        const t = evaluate(child, facts);
        const include = want === deciding ? t === deciding
          : want === UNKNOWN ? t === UNKNOWN : true;
        // The REQUESTED truth travels down, never the child's actual one.
        // They are identical for any honest question; they diverge only when
        // somebody asks why a determination was refused that was not refused,
        // and there the walk must run out of clauses rather than re-anchor.
        if (include) out.push(...walk(child, facts, want, join(path, `${kind}[${i}]`), negated));
      });
      return out;
    }
  }
  if ('not' in rule) return walk(rule.not, facts, negate(want), join(path, 'not'), !negated);

  const t = evaluate(rule, facts);
  return t === want
    ? [{
      path: path === '' ? 'rule' : path,
      fact: rule.fact, op: rule.op, value: rule.value, truth: t,
      polarity: negated ? 'negated' : 'direct',
    }]
    : [];
}

/**
 * A value in the cell a correction describes: try the literals and their
 * neighbours until every constraint holds. The same partition the issuer
 * searched, so if the issuer found a cell, this finds a member of it.
 */
function witness(c) {
  const lits = c.constraints.flatMap((k) => (Array.isArray(k.value) ? k.value : [k.value]));
  const kinds = new Set(lits.map((v) => typeof v));
  if (kinds.size !== 1) return undefined;
  const kind = [...kinds][0];
  const cands = kind === 'boolean' ? [true, false]
    : kind === 'number' ? [...new Set(lits.flatMap((n) => [n - 1, n, n + 1]))].sort((a, b) => a - b)
      : [...new Set(lits), lits.join('') + '\u0001'];
  const type = kind === 'boolean' ? 'bool' : kind === 'number' ? 'int' : 'str';
  for (const value of cands) {
    const f = { type, value };
    const ok = c.constraints.every((k) => {
      try { return evaluate({ fact: c.fact, op: k.op, value: k.value }, { [c.fact]: f }) === k.truth; }
      catch { return false; }
    });
    if (ok) return f;
  }
  return undefined;
}

/* ── §7.0f · Generic canonical JSON, for the signed core ─────────────── */

/**
 * NOT the §5 rule canonical form: this sorts object keys and NFC-normalises
 * strings and does nothing else, so the rule inside the core is signed AS
 * WRITTEN. Undefined members are dropped; non-finite numbers are null.
 */
export function canonicalJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
      .map(([k, x]) => [k.normalize('NFC'), x]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return 'null';
}

const CORE_FIELDS = ['seal_id', 'scope', 'disposition', 'rule', 'rule_hash', 'grammar_version', 'sealed_by',
  'sealed_at', 'expires_at', 'as_of', 'rule_ref', 'reasons', 'facts', 'remedy'];

/** The sealed core: the fields the signature covers, and no others. */
export function core(det) {
  const out = {};
  for (const k of CORE_FIELDS) out[k] = det[k] === undefined ? null : det[k];
  return out;
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Ed25519 through WebCrypto — Node 20+, and every current browser. */
export async function verifySignature(det, keys) {
  const sig = det.signature;
  const key = (keys ?? []).find((k) => k.kid === sig.kid);
  if (!key) return { ok: null, detail: `no published key for kid ${sig.kid}` };
  try {
    const pub = await crypto.subtle.importKey('raw', b64(key.public_key), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64(sig.sig), new TextEncoder().encode(canonicalJson(core(det))));
    return { ok, detail: ok ? `valid under ${sig.kid}` : `INVALID under ${sig.kid} — the core was altered or the key is wrong` };
  } catch (e) {
    return { ok: null, detail: `could not verify: ${e.message}` };
  }
}

/**
 * The post-quantum second signature (ML-DSA-65, FIPS 204), when the issuer
 * made one. WebCrypto in browsers cannot verify it yet, so it is checked
 * through node:crypto where that exists and reported as not checked where
 * it does not; the Ed25519 result above stands either way.
 */
export async function verifySignaturePq(det, keys) {
  const sig = det.signature_pq;
  const key = (keys ?? []).find((k) => k.kid === sig.kid);
  const bytes = new TextEncoder().encode(canonicalJson(core(det)));
  const verdict = (ok) => ({ ok, detail: ok ? `valid under ${sig.kid} (ml-dsa-65)` : `INVALID under ${sig.kid} (ml-dsa-65) — the core was altered or the key is wrong` });
  // Where node:crypto exists (Node 24+), check it there.
  let nodeCrypto = null;
  try { nodeCrypto = await import('node:crypto'); } catch { nodeCrypto = null; }
  if (nodeCrypto !== null) {
    if (!key) return { ok: null, detail: `no published key for kid ${sig.kid}` };
    if (key.alg !== 'ml-dsa-65') return { ok: false, detail: `key ${sig.kid} is ${key.alg}, not ml-dsa-65` };
    try {
      const pub = nodeCrypto.createPublicKey({ key: Buffer.from(key.public_key, 'base64'), format: 'der', type: 'spki' });
      return verdict(nodeCrypto.verify(null, Buffer.from(bytes), pub, Buffer.from(sig.sig, 'base64')));
    } catch (e) {
      return { ok: null, detail: `could not verify: ${e.message}` };
    }
  }
  // A browser. WebCrypto is expected to gain ML-DSA under this name; try it,
  // and say plainly when it is not there yet. The Ed25519 result stands.
  if (key && key.alg === 'ml-dsa-65') {
    try {
      const pub = await crypto.subtle.importKey('spki', b64(key.public_key), { name: 'ML-DSA-65' }, false, ['verify']);
      return verdict(await crypto.subtle.verify({ name: 'ML-DSA-65' }, pub, b64(sig.sig), bytes));
    } catch { /* not supported here yet */ }
  }
  return { ok: null, detail: `present (ml-dsa-65, kid ${sig.kid}); this browser cannot check it yet — run verify-cli.mjs on Node 24 or later. The Ed25519 signature above is what this page checked` };
}

/* ── Transparency: the record's date, without the issuer's key ─────────── */

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
async function sha256Hex(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total); let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}
/** RFC 6962: leaf = sha256(0x00 || leaf), node = sha256(0x01 || left || right). */
export async function merkleRootFromPath(leafHex, steps) {
  let h = await sha256Hex(new Uint8Array([0]), hexToBytes(leafHex));
  for (const s of steps) {
    h = s.side === 'left' ? await sha256Hex(new Uint8Array([1]), hexToBytes(s.hash), hexToBytes(h))
                          : await sha256Hex(new Uint8Array([1]), hexToBytes(h), hexToBytes(s.hash));
  }
  return h;
}

/**
 * Walk the record's inclusion proof: core → workspace root → global root,
 * then compare the global root with a published list if the caller has one.
 */
export async function verifyInclusion(det, roots) {
  const inc = det.inclusion;
  if (inc.algorithm !== 'rfc6962-sha256/1') return { ok: false, detail: `unknown transparency algorithm ${inc.algorithm}` };
  const leaf = await sha256Hex(new TextEncoder().encode(canonicalJson(core(det))));
  if (leaf !== inc.leaf) return { ok: false, detail: 'the record\'s core does not hash to the leaf the proof claims' };
  const wsRoot = await merkleRootFromPath(leaf, inc.workspace.path);
  if (wsRoot !== inc.workspace.root) return { ok: false, detail: 'the path does not reach the workspace root it claims' };
  if (inc.global == null) return { ok: null, detail: `reaches the workspace root for ${inc.day}; no global root yet` };
  const gRoot = await merkleRootFromPath(inc.workspace.root, inc.global.path);
  if (gRoot !== inc.global.root) return { ok: false, detail: 'the path does not reach the global root it claims' };
  const published = (roots ?? []).find((r) => r.day === inc.day);
  if (!published) return { ok: null, detail: `reaches global root ${gRoot.slice(0, 16)}… for ${inc.day}; not checked against a published list` };
  if (published.root !== gRoot) return { ok: false, detail: `the global root for ${inc.day} differs from the published one` };
  return { ok: true, detail: `included in the published global root for ${inc.day}` + (published.anchor ? ' (anchored)' : ' (not yet anchored)') };
}

/* ── §8 · Verification procedure ─────────────────────────────────────── */

const CONSISTENT = {
  [TRUE]: ['sealed', 'clawed', 'expired'],
  [FALSE]: ['lapsed', 'clawed', 'expired'],
  [UNKNOWN]: ['tainted', 'clawed', 'expired'],
};

/**
 * Verify a determination against values you hold yourself.
 *
 * `held` maps fact name to `{ type, value }`. Every step is reported
 * separately rather than collapsed into a boolean: a verifier that says only
 * "invalid" is one nobody can act on.
 */
export async function verify(det, held = {}, opts = {}) {
  const steps = [];
  const add = (step, ok, detail) => steps.push({ step, ok, detail });

  add('grammar version', (opts.grammars ?? ['1']).includes(det.grammar_version),
    `declared ${det.grammar_version}`);
  add('commitment scheme',
    (opts.schemes ?? ['sha256-v1']).includes(det.commitment_scheme ?? 'sha256-v1'),
    `declared ${det.commitment_scheme ?? 'sha256-v1'} (assumed)`);

  const rh = await ruleHash(det.rule);
  add('rule hash', rh === det.rule_hash,
    rh === det.rule_hash ? rh : `recomputed ${rh}, record says ${det.rule_hash}`);

  // §7.0a — a registered-rule snapshot, if present, must name the rule that
  // was actually sealed. That is the only thing about it a stranger can check,
  // and the record does not depend on the registry still existing.
  if (det.rule_ref != null) {
    const same = det.rule_ref.version === det.rule_hash;
    add('rule ref', same, same
      ? `${det.rule_ref.ruleset}/${det.rule_ref.rule_id} · ${det.rule_ref.legal_authority ?? 'no authority cited'}`
      : `snapshot says version ${det.rule_ref.version}, record says ${det.rule_hash}`);
  }

  const facts = {};
  let checked = 0, matched = 0;
  for (const f of det.facts ?? []) {
    const mine = held[f.fact];
    if (mine === undefined) continue;
    checked++;
    const d = await valueDigest(mine.type ?? f.fact_type, mine.value);
    if (d === f.value_sha256) { matched++; facts[f.fact] = { type: f.fact_type, value: mine.value }; }
    else add(`commitment · ${f.fact}`, false, `your value digests to ${d}, record says ${f.value_sha256}`);
  }
  // No values is UNVERIFIABLE, not invalid: a record nobody supplied values
  // for has not failed anything. (It was reported as a failure until the
  // CLI made the distinction matter.)
  add('commitments', checked === 0 ? null : matched === checked,
    checked === 0
      ? 'no values supplied — supply your own record to check the rest'
      : `${matched} of ${checked} supplied values match`);

  if (matched === checked && checked === (det.facts ?? []).length && checked > 0) {
    const truth = evaluate(det.rule, facts);
    const ok = (CONSISTENT[truth] ?? []).includes(det.state);
    add('re-evaluation', ok, `rule now evaluates ${truth}; record states "${det.state}"`
      + (ok ? '' : ` — expected one of ${CONSISTENT[truth].join(', ')}`));

    if (det.reasons?.length) {
      const named = [...new Set(det.reasons.map((r) => r.fact))];
      const narrowed = Object.fromEntries(Object.entries(facts).filter(([k]) => named.includes(k)));
      add('reasons · sufficiency', evaluate(det.rule, narrowed) === truth,
        'restricting facts to those the reasons name gives the same outcome');
    }
  } else if (checked > 0) {
    add('re-evaluation', null, 'skipped — supply every fact the record names');
  }

  // §7.0d — a remedy is a claim: "change these facts into these cells and the
  // rule moves to `target`". Checkable with held values, and worth checking:
  // a remedy that does not work is a notice telling somebody to do the wrong
  // thing. Minimality is a search property and is not re-derived here.
  if (det.remedy != null && Object.keys(facts).length === (det.facts ?? []).length
      && (det.facts ?? []).length > 0) {
    const results = det.remedy.sets.map((set) => {
      const over = {};
      for (const c of set) {
        const v = witness(c);
        if (v === undefined) return false;
        over[c.fact] = v;
      }
      try { return evaluate(det.rule, { ...facts, ...over }) === det.remedy.target; } catch { return false; }
    });
    add('remedy · effective', results.every(Boolean),
      `${results.filter(Boolean).length} of ${results.length} correction set(s) move the rule to ${det.remedy.target}`
      + (det.remedy.exhaustive ? '' : ' (search was bounded)'));
  }

  // §7.0f — the issuer's signature. Only under a key the caller supplied:
  // a verifier that fetched the key from the record's own URL would be
  // asking the issuer to vouch for itself.
  if (det.signature != null) {
    const r = await verifySignature(det, opts.keys);
    add('signature', r.ok, r.detail);
  } else {
    add('signature', null, 'unsigned — internally consistent at best; nothing says who issued it');
  }
  // The second signature, when issued. Absent is not a finding — unless the
  // caller's policy requires it: a verifier in 2038 may decide that an
  // Ed25519-only record from 2026 is no longer proof of anything, and say so.
  if (det.signature_pq != null) {
    const r = await verifySignaturePq(det, opts.keys);
    add('signature · post-quantum', opts.requirePq && r.ok === null ? false : r.ok,
      opts.requirePq && r.ok === null ? `${r.detail} — and this verifier requires it` : r.detail);
  } else if (opts.requirePq) {
    add('signature · post-quantum', false, 'no post-quantum signature, and this verifier requires one');
  }
  // The transparency anchor, when the caller attached the record's inclusion
  // proof (GET /v1/seals/:id/inclusion) and, optionally, the published roots.
  if (det.inclusion != null) {
    const r = await verifyInclusion(det, opts.roots);
    add('inclusion', r.ok, r.detail);
  }

  // ACCURACY is checkable with no values at all: it is a property of the
  // reasons and the paths alone. Sufficiency is monotone and cannot catch
  // over-reporting, so this is the one that finds a reason offered for an
  // outcome it does not carry.
  if (det.reasons?.length) {
    const bad = det.reasons.filter((r) => {
      const parity = r.path.split('.').filter((s) => s === 'not').length % 2;
      return (parity === 1) !== (r.polarity === 'negated');
    });
    add('reasons · accuracy', bad.length === 0,
      bad.length === 0 ? 'every polarity matches the parity of its path'
        : `${bad.length} reason(s) whose polarity disagrees with their path`);
  }

  add('no subject identifier', !JSON.stringify(det).includes('subject_id'),
    'a determination is about a decision, not a person');

  return { steps, ok: steps.every((s) => s.ok !== false) };
}
