#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
#
# Proves the build is reproducible: two clean builds of the committed tree, from
# two checkout paths of different depth, must be byte-identical and must contain
# nothing that names the machine or the path that produced them.
#
# Why two paths and not two runs in one directory: the defect this catches is a
# source map or an embedded filename carrying an absolute path. Two builds in
# the same directory would agree with each other and still be unreproducible
# anywhere else.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
a="$work/a"
b="$work/somewhere/deeper/b"

cleanup() {
  git -C "$root" worktree remove --force "$a" >/dev/null 2>&1 || true
  git -C "$root" worktree remove --force "$b" >/dev/null 2>&1 || true
  git -C "$root" worktree prune >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if command -v sha256sum >/dev/null 2>&1; then hash() { sha256sum "$@"; }; else hash() { shasum -a 256 "$@"; }; fi

git -C "$root" worktree add --quiet --detach "$a" HEAD
git -C "$root" worktree add --quiet --detach "$b" HEAD

for dir in "$a" "$b"; do
  # The dependency tree is the lockfile's, already installed by `npm ci`; the
  # build under test is our own compilation, not npm's resolution.
  ln -s "$root/node_modules" "$dir/node_modules"
  (cd "$dir" && npm run --silent build >/dev/null)
done

(cd "$a/dist" && find . -type f | LC_ALL=C sort | while read -r f; do hash "$f"; done) > "$work/a.sums"
(cd "$b/dist" && find . -type f | LC_ALL=C sort | while read -r f; do hash "$f"; done) > "$work/b.sums"

files="$(wc -l < "$work/a.sums" | tr -d ' ')"
if [ "$files" -eq 0 ]; then
  echo "::error::the build produced no files; a gate that compared nothing proves nothing"
  exit 1
fi

if ! cmp -s "$work/a.sums" "$work/b.sums"; then
  echo "::error::two builds of the same commit differ"
  diff "$work/a.sums" "$work/b.sums" | head -20
  exit 1
fi

if grep -rlF "$work" "$a/dist" "$b/dist" >/dev/null 2>&1; then
  echo "::error::build output contains the absolute path it was built at"
  grep -rlF "$work" "$a/dist" "$b/dist" | head -10
  exit 1
fi

echo "reproducible: $files files byte-identical across two checkout paths, no absolute paths"
