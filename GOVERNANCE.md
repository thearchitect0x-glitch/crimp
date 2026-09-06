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

**Status: two of three done, and the missing one is the one that matters.**

A successor is named and holds the credentials. What has NOT happened is a
rehearsal — nobody has restored this system from the runbooks without the
maintainer in the room. Until that has been done once, the plan is a belief,
and the whole premise of this product is the difference between a belief and a
record. Claiming continuity here while the restore is untested would be exactly
the kind of unfalsifiable assertion Crimp exists to refuse.

| Step | Status |
|---|---|
| A named successor with a published role | **Done** — [@mlimano5](https://github.com/mlimano5), 5 September 2026 |
| Credential escrow reachable without the maintainer | **Done** — successor holds credentials and is admin on the sibling Ratchet repository |
| One rehearsed restore, from the runbooks alone | **Not done** |

**Do the rehearsal now, while it is cheap.** Crimp has no production database,
no deployment and no customers — restoring it today means cloning a repository
and running migrations. Every commit makes that harder. See
[docs/RESTORE_REHEARSAL.md](docs/RESTORE_REHEARSAL.md); the rule is that if the
successor has to ask a question, the runbook is wrong and the runbook gets
fixed rather than the question answered.

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

Still outstanding, and neither is code:

1. **Admin on this repository.** Crimp has no remote yet. The successor gets
   admin at the same moment the remote is created, not afterwards.
2. **The rehearsal.** Recorded here with its date and duration when it happens.

A continuity plan that is documented but never exercised is the same failure
mode as an audit log nobody reads.

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
