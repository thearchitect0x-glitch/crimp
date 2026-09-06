<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Crimp

**A decision gate for AI agents.** An agent does not tell Crimp what it decided —
it submits the rule it is applying and the facts it is applying it to. Crimp
evaluates the rule, derives the outcome, and seals the rule *before the outcome
is known*.

```
POST /v1/seals   →  { rule, facts }        the agent supplies these
                 →  { disposition, … }     Crimp computes this
```

There is no field in which an agent can assert a conclusion.

## Why

Three things follow from that one inversion.

**Decisions become reproducible.** An examiner re-runs the sealed rule against
the sealed fact hashes years later and gets the identical answer. The
non-determinism did not disappear — it moved out of the *decision* and into the
*proposal*, where it is harmless. The model authored the rule; the rule made the
call.

**A hijacked agent cannot manufacture a determination.** It can propose a bad
rule, and a bad rule is visible, reviewable and reproducible in a way a bad
conclusion never is.

**A decision can withdraw its own support.** Re-evaluate the sealed rule later
against fresh attestations. If it no longer holds, the seal *lapses* — no
authority, no appeal, nobody won an argument. A fact changed.

## The measurement this exists for

Medicare Advantage publishes the only large-scale public data on how often an
automated adverse decision turns out to be wrong. **80.7% of appealed denials
are overturned. 6.2% of denials are ever appealed.**

Four in five of the decisions somebody fought were wrong. Nobody can tell you
the rate among the other 93.8%, because if nobody appealed, nobody looked. Every
existing measurement of wrongful denial is computed only on the population that
fought back — systematically the better-resourced one.

Crimp has two correction channels, and the difference between them is the point:

| Channel | Fires when | Sampling |
|---|---|---|
| `claw` | Someone contested, and won | Biased by who *can* contest |
| `lapse` | A declared premise stopped holding | **Independent of contestation** |

`lapse` is the institution discovering it was wrong about somebody who never
said a word. It is the only error signal that does not require the affected
person to have the resources to fight.

## Status

**Early, but it runs.** The grammar, the evaluator, attestation, the seal
lifecycle, pressure, the three measurements, keys and the HTTP surface all
work end to end against Postgres. There is no deployment, no billing and no
customer. Subject merge deliberately fails closed; see
[the handover note](docs/HANDOVER.md) for what else is unfinished on purpose.

### Requirements

- **Node 20.11 or newer** (`node --version`)
- **Docker**, for the local Postgres. The test suite drops and recreates its
  database on every run, so it needs a real one — the design depends on
  `FOR UPDATE`, `SKIP LOCKED`, partial indexes and advisory locks, and SQLite
  cannot express them.
- **git**

### Quick start

```bash
npm install
bash scripts/dev-db.sh up     # Postgres on :5434, in Docker
npm run migrate               # applies every migration to an empty database
npm test                      # typecheck + unit + integration + e2e
```

Then run it:

```bash
cp .env.example .env          # the defaults work for local development
npm run dev                   # control plane on :8788
```

`npm run dev` does not exit — it prints `Server listening at http://127.0.0.1:8788`
and then stays running. That is correct. Leave it, and open a second terminal:

```bash
curl -sS localhost:8788/healthz
# {"ok":true}
```

`-sS` rather than `-s` deliberately: plain `-s` silences curl's own error as well
as its progress meter, so a server that is not running produces a blank line and
no explanation. With `-sS` you get
`curl: (7) Failed to connect to localhost port 8788`, which tells you the first
terminal is the thing to look at.

### The loop, end to end

Crimp is key-only, so mint one first. There is no signup yet, so this goes
through a script rather than an endpoint:

```bash
npm run mint -- --authority operator --label "my first key"
```

Then, with `CRIMP_KEY` set to what that printed:

```bash
# 1. Attest what you know. Crimp never fetches; you push.
curl -sS localhost:8788/v1/attestations -H "Authorization: Bearer $CRIMP_KEY" \
  -H 'content-type: application/json' -d '{
    "aliases": [{"type":"card_fp","value":"4242"}],
    "facts": [
      {"fact":"carrier.delivered","type":"bool","value":false,"source":"carrier_api"},
      {"fact":"prior_refunds_90d","type":"int","value":1,"source":"core_ledger"}
    ]}'

# 2. Submit the RULE you are applying. Note there is no field for an outcome.
curl -sS localhost:8788/v1/seals -H "Authorization: Bearer $CRIMP_KEY" \
  -H 'content-type: application/json' -d '{
    "aliases": [{"type":"card_fp","value":"4242"}],
    "scope": "refund",
    "disposition": "bind",
    "rule": {"all":[
      {"fact":"carrier.delivered","op":"eq","value":false},
      {"fact":"prior_refunds_90d","op":"lt","value":3}]},
    "claw": {"authority":"principal","evidence_floor":"receipt"}}'

# 3. Ask whether an action is bound.
curl -sS localhost:8788/v1/bindings/check -H "Authorization: Bearer $CRIMP_KEY" \
  -H 'content-type: application/json' -d '{
    "aliases": [{"type":"card_fp","value":"4242"}], "scope": "refund.issue"}'
```

Re-attest `carrier.delivered` as `true` and the rule stops holding: the seal
**lapses** on the next re-evaluation, with no authority involved and nobody
having won an argument.

### Other commands

```bash
npm run typecheck             # src, test and scripts
npm run coverage              # the suite, with the floors enforced
npm run fuzz                  # property-based; FUZZ_RUNS=100000 to go deeper
npm run dev:db:down           # stop the local Postgres
```

## What Crimp will never be

- **Never a fairness arbiter.** It reports counts. It does not opine on whether
  a rule is just, and it will not ship a feature that does.
- **Never an oracle on whether a decision was right.** It holds that a
  determination was made, under which rule, on what evidence, with what
  reversal condition. Never that it was correct.
- **Never auto-reversing on a guess.** A rule that reads an unattested fact is
  `UNKNOWN`, and an unknown is surfaced rather than resolved.
- **Never storing a raw subject value.** Blinded, keyed, workspace-scoped.
- **Never performing an action.** No vendor credentials, no outbound access.
  Same boundary as Ratchet, for the same reason.

## Project documents

| | |
|---|---|
| [Roadmap](ROADMAP.md) | What the next year holds, and what will never be built |
| [Architecture](docs/ARCHITECTURE.md) | The high-level design, and what it deliberately is not |
| [Assurance case](ASSURANCE_CASE.md) | The threat model and the argument for each guarantee — including what is *not* defended |
| [Governance](GOVERNANCE.md) | Who decides, who succeeds, and the rehearsal record |
| [Handover](docs/HANDOVER.md) | What to know in the first hour, and what must stay true |
| [Restore rehearsal](docs/RESTORE_REHEARSAL.md) | The drill, and the rule that the maintainer does not help |
| [Releasing](docs/RELEASING.md) | How a release is cut, and how to verify one |
| [Contributing](CONTRIBUTING.md) | DCO, coding standards, and the testing policy |
| [Security policy](SECURITY.md) | How to report a vulnerability, and what is out of scope |
| [Code of conduct](CODE_OF_CONDUCT.md) | What is expected |

A sibling to [Ratchet](https://ratchetgate.com), which gates *actions*. Crimp
gates *conclusions*. Neither requires the other.

Apache-2.0. Built by [Deimos](https://deimos.mx).