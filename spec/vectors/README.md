<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Conformance vectors

Language-independent test cases for `docs/SPEC.md`. Plain JSON, no dependency
on this implementation or any other.

**A specification without a conformance suite is a PDF.** These exist so that
"conformant" is a checkable claim rather than an assertion, and so that two
independent implementations produce byte-identical rule hashes and identical
determinations from identical inputs. That is the entire point of publishing
the format: a determination issued by one implementation must verify under
another.

## Running them

Against this implementation:

```bash
npm run conformance
```

Against yours: read `vectors.json`, run each case, compare. The file is the
contract; the runner is a convenience.

`npm run conformance` runs them against **two** implementations: the reference
one in `src/`, and the independent one in `spec/verifier.mjs` which was written
from the specification text and imports nothing from `src/`. Two independent
implementations agreeing is the only real evidence that the specification is
sufficient — one implementation agreeing with itself proves nothing.

## What each group asserts

| Group | Spec § | Why it is here |
|---|---|---|
| `canonical` | §5 | Two rules differing only in child order are the same rule and MUST hash identically. Get this wrong and no two implementations agree on anything |
| `digest` | §6 | The commitment a verifier recomputes from values the issuer never stored |
| `evaluate` | §4 | Kleene, and specifically that an absent fact is `unknown` and never `false` |
| `reasons` | §7.1 | Sufficiency **and** accuracy. Sufficiency alone cannot catch over-reporting |
| `refuse` | §3 | Rules the grammar must reject. A permissive implementation is a non-conformant one |

## Adding a vector

Add the case, run the suite, and if this implementation disagrees, **work out
which side is wrong before changing either.** A vector that was edited to match
an implementation is not a vector.
