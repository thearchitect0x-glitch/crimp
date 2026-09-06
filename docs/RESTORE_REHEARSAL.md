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

## Steps

Work on a machine that has never run this project. A clean container or a
borrowed laptop is ideal; your own machine with the working copy deleted is
acceptable. The failure this catches is a dependency that only exists because
the maintainer installed it two years ago.

1. **Get the code.** Clone from the remote using your own credentials. If you
   cannot, the escrow has already failed and that is the finding.

2. **Read `README.md`, then `CONTRIBUTING.md`.** Do not skip to the commands.
   Part of what is being tested is whether the documents explain the system to
   somebody who did not build it.

3. **Bring up the database.**
   ```bash
   npm install
   bash scripts/dev-db.sh up
   ```

4. **Apply the schema to an empty database.**
   ```bash
   npm run migrate
   ```
   Every migration must apply cleanly from nothing. A schema that only exists
   because migrations were applied in a particular historical order is not a
   schema you can restore.

5. **Prove it works.**
   ```bash
   npm test
   ```
   Typecheck, unit, integration and end-to-end, against a disposable database.
   Green here means the system you have restored behaves like the one that was
   lost.

6. **Start it.**
   ```bash
   cp .env.example .env
   npm run dev
   curl -s localhost:8788/healthz
   ```

7. **Exercise one real path.** Mint a key, attest a fact, seal a determination,
   check it. If you cannot work out how from `README.md` alone, that is a
   finding and it is a serious one — the same gap will stop a customer.

8. **Confirm the domain.** You can reach the registrar for `crimpgate.com` and
   change a DNS record. You do not have to change one.

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
