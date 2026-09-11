# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
#
# One image, two processes. The API and the worker run the same build and are
# selected by command, because they must never drift: the worker re-evaluates
# rules under the same grammar the API sealed them with, and a version skew
# between them would silently re-decide determinations under semantics nobody
# agreed to. `grammar_version` catches that after the fact; sharing one image
# stops it happening.

FROM node:24-alpine AS build
WORKDIR /app
# Manifests first, so a dependency layer survives a source-only change.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Compiles to dist/ and copies the .sql migrations alongside — they are read
# from disk at boot, so leaving them behind produces an image that starts and
# then cannot migrate.
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# tini reaps zombies and forwards signals. Without it the worker never sees
# SIGTERM, so a deploy kills it mid-sweep instead of letting it stop cleanly.
RUN apk add --no-cache tini
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Read from disk at request time, not compiled: the format's home (served at
# `/`) and the independent verifier (embedded in a person's copy). server.ts
# refuses to start in production without them, so a build that forgets these
# lines fails loudly rather than 404ing the site.
COPY web ./web
COPY spec ./spec

# Non-root. The process needs no filesystem writes at all.
USER node

EXPOSE 8788
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/api/server.js"]
