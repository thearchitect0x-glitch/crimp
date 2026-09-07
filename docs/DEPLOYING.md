<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# Deploying

Two processes from one image. Read the worker section before changing
anything about it.

## What runs

| Process | Command | Notes |
|---|---|---|
| `api` | `node dist/api/server.js` | Stateless. Scale horizontally. Migrates on boot behind a transaction-scoped advisory lock, so several may start at once |
| `worker` | `node dist/worker/main.js` | **Must be long-running.** See below |

They share one image on purpose. The worker re-evaluates rules under the same
grammar the API sealed them with, and a version skew between the two would
silently re-decide determinations under semantics nobody agreed to.
`grammar_version` catches that after the fact; one image stops it happening.

## The worker must not be allowed to stop

It is the correction channel. A determination lapses when the rule behind it
stops holding — no appeal, no authority, nobody having won an argument — which
is the only error signal that does not require the affected person to have the
resources to fight. About nine in ten Medicaid denials are never appealed, so
it is also the only one that sees them.

**It has no inbound requests.** Any autoscaler measuring HTTP traffic will
conclude it is idle and suspend it, and nothing will break visibly.
Determinations simply stop being corrected, `sweepLag` climbs, and you find out
from a customer. Expiry is time-driven — nothing is attested when a
determination merely runs out — so there is no request that would wake it.

It is also a condition of enhanced federal funding: 42 CFR 433.112(b)(15)
requires evidence that outcomes are met *on an ongoing basis*, and no reading
of "ongoing" survives a process the platform is free to stop.

`fly.toml` sets `auto_stop_machines = "off"` and `min_machines_running = 1` for
it. Multiple replicas are safe — every state change is a compare-and-set
against the state the sweep observed, so a race loses cleanly.

## The two probes answer different questions

| | Checks the database | On failure |
|---|---|---|
| `GET /healthz` | **No, deliberately** | Restart the process |
| `GET /readyz` | Yes, plus pending migrations | Stop sending traffic |

`/healthz` must not check the database. A liveness probe that checks a
dependency turns an outage into a restart loop across every replica at once:
the orchestrator kills healthy processes for a fault they cannot fix by dying,
and the reconnect stampede makes the outage worse.

`/readyz` returns `503` while any migration is pending, which is what a rolling
deploy produces and what a probe asking only "is the process alive" cannot see.
Neither response carries a connection string, a host, or a driver error — a
readiness probe is reachable from wherever the load balancer sits.

## Secrets

`AUTH_SECRET` and `BLIND_SECRET` must both be at least 32 characters, must not
be the development default, and **must differ from each other**.
`assertProductionSafety()` refuses to start otherwise.

They differ because they have different rotation semantics, and this is the one
that will hurt if it is got wrong. Rotating `AUTH_SECRET` invalidates API keys,
which is an inconvenience. `BLIND_SECRET` cannot be rotated at all: a blinded
alias cannot be re-derived, because the input was never stored. Losing it does
not degrade the system, it **orphans every determination in it, permanently.**

```bash
fly secrets set \
  AUTH_SECRET="$(openssl rand -base64 48)" \
  BLIND_SECRET="$(openssl rand -base64 48)"
```

**Put `BLIND_SECRET` in escrow before the first determination is sealed.** Not
after. See `GOVERNANCE.md`.

## First deploy

```bash
fly launch --no-deploy --copy-config
fly postgres create --name crimp-db --region sjc
fly postgres attach crimp-db
fly secrets set AUTH_SECRET=... BLIND_SECRET=...
fly deploy
```

Then confirm both, because a deploy that reports success is not the same as a
system that works:

```bash
curl -sS https://<app>.fly.dev/readyz          # {"ready":true,...}
fly logs -p worker | head                       # {"msg":"worker started",...}
```

## Verified locally before this was written

```
image builds, migrations present in dist/
database up      → /healthz 200   /readyz 200 {"ready":true}
database down    → /healthz 200   /readyz 503 {"ready":false,"database":"down"}
worker in-image  → "worker started" → SIGTERM → "worker stopping" → "worker stopped", exit 0
```

That last line is why `tini` is in the image. Without an init, PID 1 ignores
`SIGTERM` by default, Docker `SIGKILL`s after the grace period, and every
deploy kills a sweep mid-transaction.
