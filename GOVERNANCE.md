<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Governance

Who decides, and what happens if they stop.

This file exists first rather than last. Ratchet's own roadmap names continuity
as "the largest single risk to anyone depending on Ratchet", outranking every
feature on it. Crimp is being built to hold determinations that regulated buyers
will place inside audit scope — which converts that risk from the operator's
problem into the customer's examiner's problem. It has to be answered on day
one or it will not be answered at all.

## Roles

| Role | Holder | Responsibility |
|---|---|---|
| **Maintainer** | thearchitect0x-glitch | Merges changes, cuts releases, owns the roadmap, holds production credentials |
| **Successor** | [@mlimano5](https://github.com/mlimano5) | Assumes all maintainer duties on invocation of the continuity plan |
| **Security contact** | See [SECURITY.md](SECURITY.md) | Receives and triages vulnerability reports |

## Decisions

Technical decisions are made by the maintainer and recorded in
`docs/handoff/DECISIONS.md` — what was decided, why, what was rejected, and what
would change it. A decision without a recorded alternative is not a decision,
it is a habit.

Changes to anything in `src/domain/rule.ts` or `src/domain/evaluate.ts` require
an entry in that log regardless of size. Every rule ever sealed is evaluated by
that grammar forever; there is no such thing as a small change to it.

## Continuity plan

**Status: rehearsed.** All three, and the third is the one that makes the other
two mean anything.

| Step | Status |
|---|---|
| A named successor with a published role | **Done** — [@mlimano5](https://github.com/mlimano5), 5 September 2026 |
| Credential escrow reachable without the maintainer | **Done** — holds credentials, admin here and on the sibling Ratchet repository |
| One rehearsed restore, from the runbooks alone | **Done** — 6 September 2026, 1h 30m, 4 findings |

### The rehearsal, 6 September 2026

Performed by @mlimano5 in the successor role, 22:45 to 00:15 — **one hour and
thirty minutes**. The maintainer was not consulted at any point. Claude Code
was used and that was explicitly allowed: the rule is *don't ask the person who
built it*, and a successor in a real emergency has every tool available except
him.

**Outcome: the system restores.** Migrations applied to an empty database, the
service started, and one real decision path ran end to end — key minted, fact
attested, determination sealed, binding confirmed with
`{"bound":true,"reason":"bound.refusal_standing"}`.

**Four findings, all of them defects in the documents rather than the code.**
None was findable by the person who wrote them.

1. **A harmless startup warning that reads like a crash.** An ajv strict-mode
   line printed on every boot, in the one step whose correct outcome is "it
   sits there and does nothing" — indistinguishable from a failure to somebody
   who has not seen a Node service start. Fixed in
   [#3](https://github.com/thearchitect0x-glitch/crimp/pull/3).
2. **`curl -s` hides curl's own error.** A server that was not up produced a
   blank line and no explanation, with no way to tell which earlier step to
   return to. Fixed in [#3](https://github.com/thearchitect0x-glitch/crimp/pull/3).
3. **The two runbooks disagreed on step numbers.** "Stuck at step 8" meant
   *start the service* in one document and *confirm the domain* in the other —
   during the one exercise whose entire purpose is communicating a problem
   accurately. Both now number 00 to 11 identically, and the runbook says why
   renumbering is not a cosmetic change.
4. **`git pull` does not restart a running server.** The merged fix appeared to
   do nothing until the process was stopped and started again. Obvious once
   known; ten confusing minutes if not. Now called out beside the start step.

**Step 10, the domain.** Registrar access confirmed under sole control — his
own password, no code required from anyone else's device. The DNS controls were
present and nothing was changed. Two observations recorded rather than acted on:
the registrar is password-only, so **adding 2FA there is worthwhile hardening**
(not a continuity gap, since he can already get in unaided); and the domain has
**no DNS records configured at all**, which is consistent with there being no
deployment. Today "confirm the domain" means *I can control it*. Once something
is deployed, this step has to grow into *the records point at the running
service*, and there is nothing yet to check that against.

**Re-rehearse when the shape of the system changes** — specifically when a
production database or a deployment exists. A rehearsal that covered less than
the current system has stopped being a rehearsal.

What is already true:

- Everything needed to rebuild the service from nothing is in this repository:
  schema migrations, deployment config, CI, and the operational runbooks in
  `docs/handoff/`.
- No component depends on undocumented local state. A clean checkout plus the
  documented environment variables reproduces the system.
- The grammar and evaluator carry no external dependencies, so the component
  with permanent semantics has no supply chain that can rot underneath it.

- The successor is admin on the sibling Ratchet repository and holds its
  credentials, so the access path is one somebody has actually used rather than
  one that exists on paper.

- The successor has admin on this repository and has exercised it — he has
  reviewed, approved and merged three pull requests, so the access path is one
  somebody has used rather than one that exists on paper.

A continuity plan that is documented but never exercised is the same failure
mode as an audit log nobody reads. This one has now been exercised once, and it
produced four defects — which is the argument for doing it again rather than
filing it as complete.

## Review

Every change to `main` requires a pull request with an approving review from
somebody other than its author, enforced by a branch ruleset with **no bypass
actors** — the maintainer included.

This is in place from the ninth commit, which is the whole reason to do it now.
Ratchet adopted the same rule on 5 September 2026, by which point 244 of its 247
commits had already reached `main` unreviewed; that history does not disappear
and it complicates an otherwise clean answer to the OpenSSF gold
`two_person_review` criterion. Crimp has eight such commits and can simply not
have that problem.

## Changing this file

By pull request. If the successor row is still UNFILLED a year from now, that is
information about the project's actual risk, and it belongs in the README rather
than buried here.