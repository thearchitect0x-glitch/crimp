<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Handover

For [@mlimano5](https://github.com/mlimano5), or whoever holds this next.

Written while the maintainer is available, because a handover note written after
it is needed is a note nobody wrote.

## What Crimp is, in one paragraph

A decision gate for AI agents. An agent does not tell Crimp what it decided —
there is no field for that. It submits **the rule it is applying** and pointers
to **attested facts**, and Crimp evaluates the rule and derives the outcome. The
rule is sealed before the outcome is known. Later, the same rule is re-run
against current facts: if it no longer holds the determination **lapses**, with
no authority involved and nobody having won an argument.

## Why it exists, in one number

Medicare Advantage overturns **80.7%** of appealed denials. Only **6.2%** of
denials are ever appealed. Nobody can tell you the error rate among the other
93.8%, because if nobody appealed then nobody looked.

`lapse` measures that population. It is the only correction channel that does
not require the affected person to have the resources to fight. Everything else
in the codebase is machinery that exists so that number can be computed.

If you only defend one thing here, defend that.

## The first hour

You do not need to understand the product to keep it alive.

```bash
git clone <remote> && cd crimp
npm install
bash scripts/dev-db.sh up
npm run migrate
npm test
```

Green means the system is intact. `docs/RESTORE_REHEARSAL.md` is the longer
version and you should have already done it once.

## What must stay true

These are not preferences. Each is load-bearing and each has tests that fail if
it stops being true.

1. **Authority comes from the credential, never the request.** There is no
   `sealed_by`, no `actor`, no `workspace_id` in any request body. If a schema
   ever accepts one, everything else here is decoration.
2. **An agent cannot lift what it sealed.** The claw authority must strictly
   exceed the sealer, and a key mints only keys strictly below itself.
3. **UNKNOWN is not FALSE.** A rule reading an unattested fact has not been
   answered. It never silently becomes a lapse.
4. **The grammar cannot be narrowed.** Every rule ever sealed is evaluated by
   it forever. It may be widened only in ways that leave existing rules'
   meaning unchanged.
5. **The historical raw value is never stored.** Only the current attestation
   and a digest. This is what makes erasure a `DELETE` rather than a crisis.
6. **Pressure hardens `bind` only.** Never `permit`, never `commit` — otherwise
   it is a lock any attacker can throw at somebody else's grant.

`CONTRIBUTING.md` has the testing policy. `docs/` has the rest.

## What is deliberately unfinished

Do not treat these as bugs to be tidied.

- **Subject merge fails closed.** When presented aliases already belong to
  several subjects, Crimp refuses with `merge_required` rather than unioning
  them. Merges are monotone and therefore permanent, and a wrong permanent merge
  drags strangers under somebody else's determination with no way back. Build it
  when real customer data forces the design, not before.
- **Scopes are a tree, not a DAG.** A seal on `money.out` does not catch a
  refund. Widening to a DAG later is safe; narrowing would not be, which is why
  this order.
- **The attestation trust root belongs to the customer.** An institution that
  attests false facts can produce a mathematically perfect proof of a wrong
  decision. This is permanent and documented in `SECURITY.md`. Closing it would
  require holding customer credentials, which would destroy the property the
  product is built on.
- **Constant-time key comparison is not enforced by a test.** See `SECURITY.md`.
  Review that function by reading it.

## Where the risk actually is

Not in the code. In the two things below.

- **Freedom to operate.** Daon holds US 12,688,261, granted 21 July 2026,
  claiming an authorization checkpoint that issues a scoped, time-limited
  permission artifact. That reads closer to *Ratchet* than to Crimp, and no
  qualified person has looked at it. There is also an active continuation family
  from an individual inventor whose claims nobody has read.
- **This document going stale.** It is true on 5 September 2026. If it disagrees
  with the code, the code is right and this file is a bug.

## Who to tell

Vulnerabilities: `SECURITY.md`. Everything else: open an issue.
