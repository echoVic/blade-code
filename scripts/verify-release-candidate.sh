#!/usr/bin/env bash
#
# verify-release-candidate.sh
#
# Pre-tag gate for Blade Code releases. Codifies steps 7-8 of the
# "Prepare and Qualify the Exact Candidate" section in AGENTS.md so a
# single command enforces every local release precondition.
#
# Usage:
#   scripts/verify-release-candidate.sh                # verify current package.json version
#   scripts/verify-release-candidate.sh 0.11.13        # verify the exact candidate version
#
# Exit status is non-zero on the first failing check so CI, pre-commit
# hooks, and interactive callers can rely on it as a hard gate.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

PACKAGE_JSON="packages/cli/package.json"
[[ -f "$PACKAGE_JSON" ]] || fail "missing $PACKAGE_JSON"

PACKAGE_VERSION="$(node -p "require('./$PACKAGE_JSON').version")"
EXPECTED_VERSION="${1:-$PACKAGE_VERSION}"

if [[ ! "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "version must be semver x.y.z, got '$EXPECTED_VERSION'"
fi

if [[ "$EXPECTED_VERSION" != "$PACKAGE_VERSION" ]]; then
  fail "package.json has $PACKAGE_VERSION but candidate is $EXPECTED_VERSION"
fi

TAG="v$EXPECTED_VERSION"
log "verifying release candidate $TAG"

# 1. Clean working tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "working tree is dirty; commit or stash before tagging"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  fail "untracked or ignored changes present; clean the tree before tagging"
fi

# 2. Changelogs must contain this version heading.
CHANGELOG_HEADING="## [$EXPECTED_VERSION]"
grep -F -- "$CHANGELOG_HEADING" CHANGELOG.md    >/dev/null || fail "CHANGELOG.md missing '$CHANGELOG_HEADING'"
grep -F -- "$CHANGELOG_HEADING" CHANGELOG.zh.md >/dev/null || fail "CHANGELOG.zh.md missing '$CHANGELOG_HEADING'"

# 3. Tag must not already exist locally or on origin.
if git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  fail "local tag $TAG already exists"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "remote tag $TAG already exists on origin"
fi

# 4. npm must not already have this version.
if command -v npm >/dev/null 2>&1; then
  if NPM_VERSION="$(npm view "blade-code@$EXPECTED_VERSION" version 2>/dev/null)" && [[ -n "$NPM_VERSION" ]]; then
    fail "npm already has blade-code@$EXPECTED_VERSION"
  fi
else
  log "npm not found; skipping npm version check"
fi

# 5. Run the full local release gate (same commands documented in AGENTS.md).
log "bun install --frozen-lockfile"
bun install --frozen-lockfile

log "bun run build"
bun run build

log "bun run test:all"
bun run test:all

log "bun run lint"
bun run lint

log "bun run type-check"
bun run type-check

# 6. Tree must still be clean after the gate.
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git status --porcelain)" ]]; then
  fail "release gate modified the working tree"
fi

log "release candidate $TAG is clean and all gates passed"
