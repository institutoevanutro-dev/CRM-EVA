#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
source "$ROOT/hostgator-setup-kit/_common.sh"
git init -q -b main "$WORK/repo"
cd "$WORK/repo"
git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -qm main
git tag v1.0.0
git update-ref refs/remotes/origin/main HEAD
expected="$(git rev-parse HEAD)"
[ "$(trusted_release_commit v1.0.0)" = "$expected" ]
git checkout -qb attack
git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -qm unreviewed
git tag v999.0.0
if trusted_release_commit v999.0.0; then echo 'unreviewed tag accepted'; exit 1; fi
if trusted_release_commit 'v1.0.0:README'; then echo 'non-tag revision accepted'; exit 1; fi
printf 'approved tag accepted; unrelated tag and revision expression rejected\n'
