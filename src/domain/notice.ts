// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-04 · The notice is a derivation, not a document.
 *
 * Everything a notice says is already on the record: the outcome, the rule
 * and its citation, the clauses that decided it, the facts relied on, what
 * would change it, the clocks, and the appeal rights the programme's config
 * fixes. This module rearranges the record into a page. It adds nothing, so
 * the same record produces the same bytes forever, and two notices that
 * differ came from two records that differ.
 *
 * TWO FIDELITIES, AGAIN. A notice without values names the clause, the fact
 * and its source — enough to say what was applied and to whom to complain.
 * A notice WITH values ("your recorded income was 3 200") is what a person
 * actually needs, and it is produced only through `disclosure()`, which is
 * gated on authority and recorded. The notice does not open a second door.
 *
 * NO GENERATED PROSE. The wording of a clause is a fixed table of operator
 * phrases; appeal rights are config with a citation; labels are a fixed
 * dictionary a translator may replace. A sentence a model wrote cannot be
 * re-derived, so none appears.
 */
import { getPool } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { requireScope, type Principal } from './auth.js';
import { proof, disclosure, type Proof } from './record.js';
import type { DisclosedReason, Reason } from './explain.js';
import type { Remedy, Constraint } from './remedy.js';
import { loadCatalogue, type Catalogue } from './catalogue.js';
import { CLOCKS } from './clocks.config.js';
import { PROGRAMMES, programmeOf, type AppealRights } from './notice.config.js';

export const NOTICE_VERSION = 'notice-1';
/** The brief's target. Reported, never enforced: a notice is not withheld for being hard to read. */
export const READING_GRADE_TARGET = 8;

export interface NoticeClock {
  clock: string; authority: string; status: string;
  startedAt: string; dueAt: string; metAt: string | null; missedAt: string | null;
}

export interface Notice {
  version: typeof NOTICE_VERSION;
  language: string;
  sealId: string;
  programme: string;
  outcome: {
    disposition: string; state: string; scope: string;
    sealedAt: string; expiresAt: string | null;
    /** A fixed word per (disposition, state). Never a sentence. */
    statement: string;
    /** cap-06. A ruling elsewhere put the rule this rests on under review. */
    underReview: boolean;
  };
  rule: {
    ruleHash: string; rule: unknown;
    ruleset: string | null; ruleId: string | null;
    legalAuthority: string | null; effectiveFrom: string | null; effectiveTo: string | null;
  };
  reasons: Array<Reason & { observed?: unknown; source?: string | null; wouldHaveNeeded?: number; label: string }>;
  facts: Array<{ fact: string; label: string; source: string; admissibility: string; assertedAt: string; attester: string | null }>;
  remedy: Remedy | null;
  clocks: NoticeClock[];
  appeal: AppealRights & { programme: string };
  valuesDisclosed: boolean;
  /** Fact name → what to call it on the page, from the catalogue where one exists. */
  labels: Record<string, string>;
}

/* ── Derivation (pure) ───────────────────────────────────────────────── */

const STATEMENT: Record<string, Record<string, string>> = {
  bind: { sealed: 'refused', tainted: 'under review', lapsed: 'reversed', clawed: 'overruled', expired: 'ended' },
  permit: { sealed: 'granted', tainted: 'under review', lapsed: 'withdrawn', clawed: 'overruled', expired: 'ended', exercised: 'used' },
  commit: { sealed: 'recorded', tainted: 'under review', lapsed: 'no longer holds', clawed: 'overruled', expired: 'ended' },
};

export function deriveNotice(input: {
  proof: Proof;
  disclosed?: DisclosedReason[] | null;
  clocks?: NoticeClock[];
  catalogue?: Catalogue;
  language?: string;
}): Notice {
  const p = input.proof;
  const programme = programmeOf(p.scope);
  const cfg = PROGRAMMES[programme];
  if (cfg === undefined) {
    throw new ApiError(409, 'programme_not_configured',
      `No appeal rights are configured for programme "${programme}" (from scope "${p.scope}"). `
      + 'A notice without appeal rights is not a notice; configure the programme first.',
      { programme, known: Object.keys(PROGRAMMES).sort() });
  }
  const label = (fact: string): string => input.catalogue?.get(fact)?.description ?? fact;
  const reasons = (input.disclosed ?? p.reasons).map((r) => ({
    ...r, label: label(r.fact),
  }));
  const named = new Set<string>([
    ...p.reasons.map((r) => r.fact), ...p.facts.map((f) => f.fact),
    ...(p.remedy?.sets.flat().map((c) => c.fact) ?? []),
  ]);
  const labels = Object.fromEntries([...named].sort().map((f) => [f, label(f)]));
  return {
    version: NOTICE_VERSION,
    language: input.language ?? 'en',
    sealId: p.sealId,
    programme,
    outcome: {
      disposition: p.disposition, state: p.state, scope: p.scope,
      sealedAt: p.sealedAt.toISOString(), expiresAt: p.expiresAt?.toISOString() ?? null,
      statement: STATEMENT[p.disposition]?.[p.state] ?? p.state,
      underReview: p.reviewFlaggedAt !== null && (p.state === 'sealed' || p.state === 'tainted'),
    },
    rule: {
      ruleHash: p.ruleHash, rule: p.rule,
      ruleset: p.ruleRef?.ruleset ?? null, ruleId: p.ruleRef?.ruleId ?? null,
      legalAuthority: p.ruleRef?.legalAuthority ?? null,
      effectiveFrom: p.ruleRef?.effectiveFrom.toISOString() ?? null,
      effectiveTo: p.ruleRef?.effectiveTo?.toISOString() ?? null,
    },
    reasons,
    facts: p.facts.map((f) => ({
      fact: f.fact, label: label(f.fact), source: f.source, admissibility: f.admissibility,
      assertedAt: f.assertedAt.toISOString(), attester: f.attester,
    })),
    remedy: p.remedy,
    clocks: input.clocks ?? [],
    appeal: { ...cfg.appeal, programme: cfg.name },
    valuesDisclosed: input.disclosed != null,
    labels,
  };
}

/* ── Rendering (pure) ────────────────────────────────────────────────── */

/** Every string a renderer emits that is not from the record. A translator supplies another set. */
export interface Labels {
  title: string; decision: string; scope: string; date: string; rule: string; authority: string;
  inForce: string; why: string; facts: string; source: string; remedy: string; remedyAny: string;
  remedyAll: string; clocks: string; appeal: string; appealBy: string; days: string;
  observed: string; needed: string; notCase: string; and: string; or: string; unknownValue: string;
  reference: string; verify: string; underReview: string;
  op: Record<string, string>;
}

export const LABELS_EN: Labels = {
  title: 'Notice of decision', decision: 'Decision', scope: 'About', date: 'Date', rule: 'Rule applied',
  authority: 'Legal authority', inForce: 'In force from', why: 'Why', facts: 'Facts relied on',
  source: 'source', remedy: 'What would change this', remedyAny: 'Any one of the following:',
  remedyAll: 'All of the following, together:', clocks: 'Deadlines', appeal: 'Your right to appeal',
  appealBy: 'Ask within', days: 'days', observed: 'recorded as', needed: 'the rule requires',
  notCase: 'it is not the case that', and: 'and', or: 'or', unknownValue: 'not on record',
  reference: 'Reference', verify: 'This notice was derived from a sealed record. Its reference '
    + 'number lets anyone with the record check every statement above.',
  underReview: 'This decision is under review following a ruling on the rule it applied. '
    + 'It still stands until it is changed, and you will be told if it is.',
  op: { eq: 'is', ne: 'is not', lt: 'is less than', lte: 'is at most', gt: 'is more than',
    gte: 'is at least', in: 'is one of', nin: 'is not one of' },
};

/**
 * The hook. A deployment supplies labels for a language; the record itself
 * is never translated (a fact name is an identifier, a citation is a
 * citation). Nothing in this repository translates anything.
 */
export interface NoticeTranslator {
  labels(language: string): Promise<Labels | null>;
  /** Fixed programme text (appeal rights) in the target language, or null if none is held. */
  appealText(programme: string, language: string): Promise<string | null>;
}

const fmt = (v: unknown): string => Array.isArray(v) ? v.map(fmt).join(', ') : typeof v === 'string' ? `"${v}"` : String(v);

/**
 * The operator that says the opposite. Exact for every operator the grammar
 * has, because evaluation is total over a typed fact: "not more than" IS
 * "at most". A page says "at most 2000", not "it is not the case that it is
 * more than 2000" — same statement, half the reading grade.
 */
const COMPLEMENT: Record<string, string> = {
  eq: 'ne', ne: 'eq', lt: 'gte', lte: 'gt', gt: 'lte', gte: 'lt', in: 'nin', nin: 'in',
};

function phrase(label: string, op: string, value: unknown, negate: boolean, L: Labels): string {
  if (!negate) return `${label} ${L.op[op] ?? op} ${fmt(value)}`;
  const c = COMPLEMENT[op];
  return c !== undefined ? `${label} ${L.op[c] ?? c} ${fmt(value)}`
    : `${L.notCase} ${label} ${L.op[op] ?? op} ${fmt(value)}`;
}

/** One clause, in words. Fixed phrases only. */
export function clauseText(r: { label: string; op: string; value: unknown; polarity?: string; truth?: string }, L: Labels): string {
  return phrase(r.label, r.op, r.value, r.polarity === 'negated', L);
}

function constraintText(label: string, k: Constraint, L: Labels): string {
  return phrase(label, k.op, k.value, k.truth !== 'true', L);
}

const date = (iso: string): string => iso.slice(0, 10);

export function renderText(n: Notice, L: Labels = LABELS_EN): string {
  const out: string[] = [];
  out.push(`${L.title}`, '');
  out.push(`${L.decision}: ${n.outcome.statement}`);
  if (n.outcome.underReview) out.push(L.underReview);
  out.push(`${L.scope}: ${n.programme}: ${n.outcome.scope}`);
  out.push(`${L.date}: ${date(n.outcome.sealedAt)}`);
  out.push('');
  out.push(`${L.rule}: ${n.rule.ruleId ?? n.rule.ruleHash.slice(0, 16)}`);
  if (n.rule.legalAuthority) out.push(`${L.authority}: ${n.rule.legalAuthority}`);
  if (n.rule.effectiveFrom) out.push(`${L.inForce}: ${date(n.rule.effectiveFrom)}`);
  out.push('', `${L.why}:`);
  for (const r of n.reasons) {
    let line = `- ${clauseText(r, L)}`;
    if (n.valuesDisclosed) {
      line += ` (${L.observed} ${r.observed === null || r.observed === undefined ? L.unknownValue : fmt(r.observed)}`
        + (r.source ? `, ${L.source}: ${r.source}` : '') + ')';
      if (r.wouldHaveNeeded !== undefined) line += ` — ${L.needed} ${r.wouldHaveNeeded}`;
    }
    out.push(line);
  }
  if (n.facts.length > 0) {
    out.push('', `${L.facts}:`);
    for (const f of n.facts) out.push(`- ${f.label} (${L.source}: ${f.source}, ${date(f.assertedAt)})`);
  }
  if (n.remedy && n.remedy.sets.length > 0) {
    out.push('', `${L.remedy}:`);
    const lead = n.remedy.sets.length > 1 ? L.remedyAny : n.remedy.sets[0]!.length > 1 ? L.remedyAll : '';
    if (lead !== '') out.push(lead);
    n.remedy.sets.forEach((set, i) => {
      const parts = set.map((c) => c.constraints.map((k) => constraintText(n.labels[c.fact] ?? c.fact, k, L)).join(` ${L.and} `));
      out.push(`${n.remedy!.sets.length > 1 ? `${i + 1}. ` : '- '}${parts.join(`; ${L.and} `)}`);
    });
  }
  if (n.clocks.length > 0) {
    out.push('', `${L.clocks}:`);
    for (const c of n.clocks) out.push(`- ${c.clock} (${c.authority}): ${c.status}, due ${date(c.dueAt)}`);
  }
  out.push('', `${L.appeal}:`);
  out.push(n.appeal.text);
  out.push(`${L.appealBy} ${n.appeal.days} ${L.days}. ${L.authority}: ${n.appeal.authority}`);
  out.push('', `${L.reference}: ${n.sealId}`);
  out.push(L.verify);
  return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n';
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderHtml(n: Notice, L: Labels = LABELS_EN): string {
  const li = (items: string[]): string => `<ul>${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;
  const parts: string[] = [];
  parts.push(`<article class="notice" lang="${esc(n.language)}" data-seal="${esc(n.sealId)}">`);
  parts.push(`<h1>${esc(L.title)}</h1>`);
  parts.push(`<dl><dt>${esc(L.decision)}</dt><dd><strong>${esc(n.outcome.statement)}</strong>`
    + (n.outcome.underReview ? `<p class="review">${esc(L.underReview)}</p>` : '') + '</dd>'
    + `<dt>${esc(L.scope)}</dt><dd>${esc(n.programme)}: ${esc(n.outcome.scope)}</dd>`
    + `<dt>${esc(L.date)}</dt><dd>${esc(date(n.outcome.sealedAt))}</dd>`
    + `<dt>${esc(L.rule)}</dt><dd>${esc(n.rule.ruleId ?? n.rule.ruleHash.slice(0, 16))}</dd>`
    + (n.rule.legalAuthority ? `<dt>${esc(L.authority)}</dt><dd>${esc(n.rule.legalAuthority)}</dd>` : '')
    + (n.rule.effectiveFrom ? `<dt>${esc(L.inForce)}</dt><dd>${esc(date(n.rule.effectiveFrom))}</dd>` : '')
    + '</dl>');
  parts.push(`<h2>${esc(L.why)}</h2>` + li(n.reasons.map((r) => {
    let s = esc(clauseText(r, L));
    if (n.valuesDisclosed) {
      s += ` <span class="observed">(${esc(L.observed)} ${esc(r.observed === null || r.observed === undefined ? L.unknownValue : fmt(r.observed))}`
        + (r.source ? `, ${esc(L.source)}: ${esc(r.source)}` : '') + ')</span>';
      if (r.wouldHaveNeeded !== undefined) s += ` — ${esc(L.needed)} ${esc(String(r.wouldHaveNeeded))}`;
    }
    return s;
  })));
  if (n.facts.length > 0) {
    parts.push(`<h2>${esc(L.facts)}</h2>` + li(n.facts.map((f) =>
      `${esc(f.label)} <small>(${esc(L.source)}: ${esc(f.source)}, ${esc(date(f.assertedAt))})</small>`)));
  }
  if (n.remedy && n.remedy.sets.length > 0) {
    const lead = n.remedy.sets.length > 1 ? L.remedyAny : n.remedy.sets[0]!.length > 1 ? L.remedyAll : '';
    parts.push(`<h2>${esc(L.remedy)}</h2>` + (lead ? `<p>${esc(lead)}</p>` : '')
      + `<ol>${n.remedy.sets.map((set) => `<li>${esc(set.map((c) =>
        c.constraints.map((k) => constraintText(n.labels[c.fact] ?? c.fact, k, L)).join(` ${L.and} `)).join(`; ${L.and} `))}</li>`).join('')}</ol>`);
  }
  if (n.clocks.length > 0) {
    parts.push(`<h2>${esc(L.clocks)}</h2>` + li(n.clocks.map((c) =>
      `${esc(c.clock)} <small>(${esc(c.authority)})</small>: ${esc(c.status)}, due ${esc(date(c.dueAt))}`)));
  }
  parts.push(`<h2>${esc(L.appeal)}</h2><p>${esc(n.appeal.text)}</p>`
    + `<p>${esc(L.appealBy)} ${n.appeal.days} ${esc(L.days)}. <small>${esc(L.authority)}: ${esc(n.appeal.authority)}</small></p>`);
  parts.push(`<footer><p>${esc(L.reference)}: <code>${esc(n.sealId)}</code></p><p><small>${esc(L.verify)}</small></p></footer>`);
  parts.push('</article>');
  return parts.join('\n') + '\n';
}

/* ── Readability (pure, reported) ────────────────────────────────────── */

export interface Readability { grade: number; target: number; meets: boolean; words: number; sentences: number; syllables: number }

/**
 * Flesch–Kincaid grade level over the plain-text rendering. The syllable
 * count is the usual heuristic (vowel groups, silent e), which is what every
 * published calculator uses; the number is comparable, not exact.
 * Identifiers and citations count as words, which is honest: the person
 * has to read them.
 */
export function readingGrade(text: string): Readability {
  const words = text.toLowerCase().match(/[a-z][a-z'_.-]*/g) ?? [];
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const syllables = words.reduce((n, w) => n + syllablesOf(w), 0);
  const w = Math.max(1, words.length);
  const grade = Math.round((0.39 * (w / sentences) + 11.8 * (syllables / w) - 15.59) * 10) / 10;
  return { grade, target: READING_GRADE_TARGET, meets: grade <= READING_GRADE_TARGET,
    words: words.length, sentences, syllables };
}

function syllablesOf(word: string): number {
  const w = word.replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = (w.replace(/e$/, '').replace(/(?:[^laeiouy]|ed|es)$/, '').match(/[aeiouy]{1,2}/g) ?? []).length;
  return Math.max(1, groups);
}

/* ── The database-facing entry point ─────────────────────────────────── */

/**
 * A notice for a determination. `values: true` goes through `disclosure()`
 * — authority-gated and recorded — because a notice with values IS a
 * disclosure, and this module must not be a way around that.
 */
export async function noticeFor(p: Principal, sealId: string, opts: {
  values?: boolean; language?: string; translator?: NoticeTranslator;
} = {}): Promise<{ notice: Notice; labels: Labels; text: string; html: string; readability: Readability }> {
  requireScope(p, 'seals:read');
  const language = opts.language ?? 'en';
  let labels: Labels = LABELS_EN;
  if (language !== 'en') {
    const got = await opts.translator?.labels(language);
    if (!got) {
      throw new ApiError(400, 'language_unavailable',
        `No notice labels are held for "${language}". This system ships English and a translation `
        + 'hook; it does not translate.', { language });
    }
    labels = got;
  }
  const rec = await proof(p, sealId);
  const disclosed = opts.values ? (await disclosure(p, sealId)).reasons : null;

  const db = getPool();
  const { rows: subj } = await db.query<{ subject_id: string }>(
    'SELECT subject_id FROM seals WHERE workspace_id = $1 AND id = $2', [p.workspaceId, sealId]);
  const { rows: clocks } = await db.query<{
    name: string; status: string; started_at: Date; due_at: Date; met_at: Date | null; missed_at: Date | null;
  }>(
    `SELECT name, status, started_at, due_at, met_at, missed_at FROM clocks
      WHERE workspace_id = $1 AND subject_id = $2
        AND (scope = '*' OR scope = $3 OR starts_with($3, scope || '.') OR starts_with(scope, $3 || '.'))
      ORDER BY started_at, name`,
    [p.workspaceId, subj[0]?.subject_id ?? '', rec.scope]);

  const notice = deriveNotice({
    proof: rec, disclosed,
    clocks: clocks.map((c) => ({
      clock: c.name, authority: CLOCKS[c.name]?.authority ?? 'unknown', status: c.status,
      startedAt: c.started_at.toISOString(), dueAt: c.due_at.toISOString(),
      metAt: c.met_at?.toISOString() ?? null, missedAt: c.missed_at?.toISOString() ?? null,
    })),
    catalogue: await loadCatalogue(db, p.workspaceId),
    language,
  });
  if (language !== 'en') {
    const t = await opts.translator?.appealText(notice.programme, language);
    if (t) notice.appeal = { ...notice.appeal, text: t };
  }
  const text = renderText(notice, labels);
  return { notice, labels, text, html: renderHtml(notice, labels), readability: readingGrade(text) };
}
