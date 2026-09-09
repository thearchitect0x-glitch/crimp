// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * cap-02 · What would change this.
 *
 * A reason says which clauses decided a determination. A remedy says the
 * smallest change to the facts that would decide it the other way — for a
 * refusal, what would make the refusal lapse. Regulation B asks for the
 * principal reasons; a person asks "so what do I do". This is the mechanical
 * answer to the second question, derived from the sealed rule and nothing
 * else, and therefore re-derivable by anyone holding the record.
 *
 * WHAT IT IS. Every minimal set of facts that, given new values, moves the
 * rule to the target truth. "Minimal" is by size: no smaller set works, and
 * every set of that size that works is reported. For each fact in a set the
 * remedy states the CELL the fact must land in — each clause of the rule on
 * that fact, with the truth it must take. That is value-free with respect to
 * the person: it is the rule's own literals rearranged, which the caller
 * already holds, and it never says what the fact IS now.
 *
 * WHY IT IS EXACT, AND WHERE IT STOPS. The rule's literals partition each
 * fact's values into cells no comparison can tell apart (see
 * `representatives` in rule.ts — the same partition the constant-conclusion
 * check uses). Trying one representative per cell is therefore exhaustive
 * for that fact, and the product of cells is exhaustive for a set of facts.
 * Sizes are searched in order, so the first size that works is minimal. The
 * search stops after REMEDY_BOUND evaluations; a remedy says whether it was
 * exhaustive, and a bounded, empty remedy is reported as exactly that rather
 * than as "nothing would help". The bound is in the specification so that a
 * second implementation reports the same thing.
 *
 * WHAT IT DOES NOT DO. It does not choose between sets, does not say which is
 * easier, and does not name a value the person should aim for. Those are
 * judgements, and judgement is the one thing this module is built not to
 * exercise.
 */
import { evaluate, RuleTypeError } from './evaluate.js';
import {
  representatives, TRUE, FALSE,
  type Rule, type Facts, type Fact, type Truth, type Comparison, type FactType,
} from './rule.js';

/** Total evaluations one remedy search may spend. Stated in SPEC §7.0d. */
export const REMEDY_BOUND = 65536;

export interface Constraint {
  /** The clause's position in the rule, as in a reason. */
  path: string;
  op: string;
  value: Comparison['value'];
  /** The truth this clause must take for the fact to be in the required cell. */
  truth: typeof TRUE | typeof FALSE;
}

export interface Correction {
  fact: string;
  factType: FactType;
  constraints: Constraint[];
}

export interface Remedy {
  /** The truth the sets move the rule to. */
  target: typeof TRUE | typeof FALSE;
  /** Every minimal correction set found, each a sorted list of facts. */
  sets: Correction[][];
  /** False if the bound was reached before the search was complete. */
  exhaustive: boolean;
  evaluations: number;
}

/**
 * The truth that is in the person's favour, per disposition. A `bind` is a
 * refusal, so what helps is the rule ceasing to hold; a `permit` is a grant,
 * so what helps is the rule holding. A `commit` records what an agent said
 * and has no side to be on.
 */
export function favourable(disposition: string): typeof TRUE | typeof FALSE | null {
  return disposition === 'bind' ? FALSE : disposition === 'permit' ? TRUE : null;
}

interface Leaf { path: string; c: Comparison }

function leaves(rule: Rule): Leaf[] {
  const out: Leaf[] = [];
  const join = (p: string, s: string): string => (p === '' ? s : `${p}.${s}`);
  const walk = (n: Rule, path: string): void => {
    if ('all' in n) return n.all.forEach((k, i) => walk(k, join(path, `all[${i}]`)));
    if ('any' in n) return n.any.forEach((k, i) => walk(k, join(path, `any[${i}]`)));
    if ('not' in n) return walk(n.not, join(path, 'not'));
    out.push({ path: path === '' ? 'rule' : path, c: n as Comparison });
  };
  walk(rule, '');
  return out;
}

/**
 * Every minimal set of fact changes that moves `rule` to `target`.
 *
 * Deterministic: facts are considered in sorted order, cells in the order
 * `representatives` yields them, and the output is sorted. Two runs, or two
 * implementations, produce identical bytes.
 */
export function corrections(rule: Rule, facts: Facts, target: Truth): Remedy {
  if (target !== TRUE && target !== FALSE) {
    throw new Error('a remedy moves a rule to true or to false, never to unknown');
  }
  const empty: Remedy = { target, sets: [], exhaustive: true, evaluations: 0 };
  const cells = representatives(rule);
  if (cells === null) return empty;  // mixed-kind literals: cannot evaluate against anything
  // Already there: nothing to change, and no search to spend.
  try { if (evaluate(rule, facts) === target) return empty; } catch (e) {
    if (!(e instanceof RuleTypeError)) throw e;
  }

  const all = leaves(rule);
  const names = [...cells.keys()].sort();
  // Candidate values per fact: one representative per DISTINCT cell, minus
  // the cell it is already in. Two representatives in one cell are the same
  // move, and changing a fact to where it already is changes nothing. This
  // is what keeps a ten-clause conjunction at 1 023 evaluations, not 59 048.
  const options = new Map<string, Fact[]>();
  for (const n of names) {
    const current = facts[n];
    const here = current === undefined ? null : cellOf(all, n, current);
    const seen = new Set<string>();
    const reps: Fact[] = [];
    for (const r of cells.get(n)!) {
      const cell = cellOf(all, n, r);
      if (cell === here || seen.has(cell)) continue;
      seen.add(cell);
      reps.push(r);
    }
    if (reps.length > 0) options.set(n, reps);
  }
  const candidates = [...options.keys()];
  let evaluations = 0;
  const sets: Correction[][] = [];

  const evalWith = (over: Record<string, Fact>): Truth | null => {
    evaluations++;
    try { return evaluate(rule, { ...facts, ...over }); } catch (e) {
      if (e instanceof RuleTypeError) return null;
      throw e;
    }
  };

  for (let size = 1; size <= candidates.length; size++) {
    for (const subset of combinations(candidates, size)) {
      const lists = subset.map((n) => options.get(n)!);
      const idx = lists.map(() => 0);
      const total = lists.reduce((a, l) => a * l.length, 1);
      for (let k = 0; k < total; k++) {
        if (evaluations >= REMEDY_BOUND) {
          return { target, sets: finish(sets), exhaustive: false, evaluations };
        }
        const over: Record<string, Fact> = {};
        subset.forEach((n, i) => { over[n] = lists[i]![idx[i]!]!; });
        if (evalWith(over) === target) {
          sets.push(subset.map((n) => ({
            fact: n,
            factType: over[n]!.type,
            constraints: all.filter((l) => l.c.fact === n).map((l) => ({
              path: l.path, op: l.c.op, value: l.c.value,
              truth: evaluate(l.c, { [n]: over[n]! }) as typeof TRUE | typeof FALSE,
            })),
          })));
          // No break: two different cells for the same facts are two different
          // remedies (`any[a=1, a=2]` from a=0 has two), and both are reported.
        }
        for (let i = 0; i < idx.length; i++) {
          if (++idx[i]! < lists[i]!.length) break;
          idx[i] = 0;
        }
      }
    }
    // The first size with a witness is the minimal size. Report every set
    // of that size and stop; a larger set is not a remedy, it is a detour.
    if (sets.length > 0) return { target, sets: finish(sets), exhaustive: true, evaluations };
  }
  return { ...empty, evaluations };
}

/** The cell a value lands in: the truth vector of the rule's leaves on that fact. */
function cellOf(all: Leaf[], fact: string, value: Fact): string {
  return all.filter((l) => l.c.fact === fact).map((l) => {
    try { return evaluate(l.c, { [fact]: value }); } catch { return 'x'; }
  }).join(',');
}

function finish(sets: Correction[][]): Correction[][] {
  // Distinct cells for the same subset are distinct remedies; identical ones
  // are not. Sorted by their canonical bytes, so the order is a fact of the
  // rule and not of the search.
  const seen = new Map<string, Correction[]>();
  for (const s of sets) seen.set(JSON.stringify(s), s);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

function* combinations<T>(items: T[], size: number): Generator<T[]> {
  const n = items.length;
  if (size > n) return;
  const idx = Array.from({ length: size }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i]!);
    let i = size - 1;
    while (i >= 0 && idx[i] === n - size + i) i--;
    if (i < 0) return;
    idx[i]!++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1]! + 1;
  }
}
