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
| **Successor** | **UNFILLED — see below** | Assumes all maintainer duties on invocation of the continuity plan |
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

**Status: incomplete, and deliberately visible.** The bus factor is 1. The
OpenSSF silver criteria require that the project continue with minimal
interruption if any one person is lost, and that transitions complete within
one week. Crimp does not meet that yet.

What is already true:

- Everything needed to rebuild the service from nothing is in this repository:
  schema migrations, deployment config, CI, and the operational runbooks in
  `docs/handoff/`.
- No component depends on undocumented local state. A clean checkout plus the
  documented environment variables reproduces the system.
- The grammar and evaluator carry no external dependencies, so the component
  with permanent semantics has no supply chain that can rot underneath it.

What is not, and what closing it requires — none of which is code:

1. **A named successor** with commit rights and a published handover note.
2. **Credential escrow**: production database, DNS, registry and signing keys
   held such that the successor can reach them without the maintainer.
3. **One rehearsal.** An untested restore is a belief. The successor performs a
   full restore into a scratch environment, from the runbooks alone, without
   the maintainer answering questions.

Until all three are done this section says so, and the badge claim will say so
too. A continuity plan that is documented but never exercised is the same
failure mode as an audit log nobody reads.

## Changing this file

By pull request. If the successor row is still UNFILLED a year from now, that is
information about the project's actual risk, and it belongs in the README rather
than buried here.
