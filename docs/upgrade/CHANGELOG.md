<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Upgrade changelog

One entry per capability as it lands, in the order it actually landed. Each
entry names the capability number, the spec section it touched, whether the
second implementation needed a change, and what a human still has to confirm.

## Phase 0 · 9 September 2026

- `00-capability-map.md` written against `integration-check` (73e1dc2). Base
  measured green: 287 tests, 32 × 2 conformance vectors, 19 fuzz properties.
- Finding F1 recorded: a presence *test* is expressible via
  `any[a=v, a≠v]`; absence still cannot seal. Tautology-over-present-values
  detection proposed for Phase 1 alongside capability 1.
- Dependency order recorded: capability 8 (rule registry) underlies 1(d), 6, 7
  and 10, and is proposed first. No format change made.
