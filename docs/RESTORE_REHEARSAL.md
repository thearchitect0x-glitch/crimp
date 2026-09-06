<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Restore rehearsal

For the successor. The maintainer does not help.

## The rule

**If you have to ask a question, the runbook is wrong.**

Write the question down, finish by whatever means you can, and then fix the
document. Do not let the maintainer answer it — an answered question repairs one
rehearsal and leaves the next person in exactly the same position. The output of
this exercise is a better runbook, not a successful restore.

## Why now, while it is boring

Crimp has no production database, no deployment, no customers and no
determinations. Restoring it today is cloning a repository and running
migrations, and it will never be this cheap again. The point of rehearsing now
is not that the restore is hard — it is to establish that the rehearsal happens
at all, before it is hard.

## Scope of this rehearsal

Everything needed to bring Crimp back from nothing but this repository and the
escrowed credentials. That currently means: the source, the schema, and the
domain name. It does not yet mean production data, because there is none.

When production exists, this document grows a data-restore section and gets
re-rehearsed. A rehearsal that covered less than the current system is not a
rehearsal any more.

## Step numbering is load-bearing — do not renumber casually

The steps below are numbered **00 to 11**, and the walkthrough page uses the
same numbers for the same actions. That is not tidiness.

The first rehearsal reported "stuck at step 8" and the two documents disagreed
about what step 8 was: this file called it *Confirm the domain*, the walkthrough
called it *Start the service*. Two people looking at the same number were
discussing different problems, during the one exercise whose entire purpose is
communicating a problem accurately. If you add a step, append it or letter it —
`04a` — rather than shifting everything below.

## Steps

Work on a machine that has never run this project. A clean container or a
borrowed laptop is ideal; your own machine with the working copy deleted is
acceptable. The failure this catches is a dependency that only exists because
the maintainer installed it two years ago.

**00. Open a terminal.**

**01. Check what is already installed.** `node --version` (20.11 or newer),
`docker --version`, `git --version`. Installing what is missing is part of the
exercise; needing something the README never mentioned is a finding.

**02. Get the code.** Clone from the remote using your own credentials. If you
cannot, the escrow has already failed and that is the finding.

**03. Read `README.md`, then `CONTRIBUTING.md`.** Do not skip to the commands.
Part of what is being tested is whether the documents explain this system to
somebody who did not build it.

**04. Install dependencies.**
```bash
npm install
```

**05. Bring up the database.**
```bash
bash scripts/dev-db.sh up
```

**06. Apply the schema to an empty database.**
```bash
npm run migrate
```
Every migration must apply cleanly from nothing. A schema that only exists
because migrations happened to be applied in a particular historical order is
not a schema you can restore.

**07. Prove it works.**
```bash
npm test
```
Typecheck, unit, integration and end-to-end against a disposable database. Green
means the system you restored behaves like the one that was lost.

**08. Start it.**
```bash
cp .env.example .env
npm run dev
```
`npm run dev` does not exit. It prints `Server listening at http://127.0.0.1:8788`
and stays running — that is correct, not a hang. In a second terminal:
```bash
curl -sS localhost:8788/healthz
```
`-sS` rather than `-s`: plain `-s` silences curl's own error along with its
progress meter, so a server that is not up produces a blank line and no
explanation.

> **If you pull new code while this is running, the running server keeps
> serving the old code.** It does not restart itself. Stop it with `Ctrl+C` and
> `npm run dev` again. Obvious once you know; invisible if you do not, and it
> costs you a confusing ten minutes wondering why a merged fix changed nothing.

**09. Exercise one real path.** Mint a key, attest a fact, seal a determination,
check the binding. If you cannot work out how from `README.md` alone, that is a
finding and a serious one — the same gap will stop a customer.

**10. Confirm the domain.** Reach the registrar for `crimpgate.com` and confirm
you could change a DNS record. Do not change one. If you needed a code from
somebody else's device to get in, that is the most important finding available
here: a password without its second factor is not access.

**11. Shut down.** `Ctrl+C` the server, then `bash scripts/dev-db.sh down`.

## Previous runs

| Date | By | Duration | Findings |
|---|---|---|---|
| 6 September 2026 | @mlimano5 | 1h 30m | 4 — two fixed in [#3](https://github.com/thearchitect0x-glitch/crimp/pull/3), two in the commit that added this table |

## Recording it

Add to `GOVERNANCE.md`, under the continuity plan:

- the date
- who performed it
- how long it took, end to end
- **every question you had to write down**

The questions are the valuable part. A rehearsal that produced none either had a
perfect runbook or an inattentive rehearser, and the first has never happened.

## What counts as failure

Not "it took a long time." These:

- A step that could not be completed from the documents alone.
- A credential the successor could not reach.
- A dependency, account or piece of local state that exists only on the
  maintainer's machine.
- Any point at which the maintainer spoke.

Each of those is a bug in the continuity plan. Fix it, note it, and rehearse
again — the second run should be shorter and quieter.
