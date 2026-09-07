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
  add('commitments', checked > 0 && matched === checked,
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
