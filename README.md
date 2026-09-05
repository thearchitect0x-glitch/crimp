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

**Early. Not usable yet.** What exists today is the predicate grammar and its
evaluator — the component whose semantics can never change once a rule has been
sealed under them, and therefore the only sensible thing to build first.

```bash
npm install
npm run typecheck
npm run test:unit
npm run fuzz          # property-based; FUZZ_RUNS=100000 to go deeper
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
| [Governance](GOVERNANCE.md) | Who decides — and the continuity plan, which is honestly incomplete |
| [Contributing](CONTRIBUTING.md) | DCO, coding standards, and the testing policy |
| [Security policy](SECURITY.md) | How to report a vulnerability, and what is out of scope |
| [Code of conduct](CODE_OF_CONDUCT.md) | What is expected |

A sibling to [Ratchet](https://ratchetgate.com), which gates *actions*. Crimp
gates *conclusions*. Neither requires the other.

Apache-2.0. Built by [Deimos](https://deimos.mx).
