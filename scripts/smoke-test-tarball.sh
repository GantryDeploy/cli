#!/usr/bin/env bash
# Installs a packed @gantrydeploy/cli tarball into an empty project and runs the
# installed `gantry` bin, so the exact artifact that will be published is exercised.
#
# Usage: scripts/smoke-test-tarball.sh path/to/gantrydeploy-cli-x.y.z.tgz
set -euo pipefail

tarball="${1:-}"
if [ -z "$tarball" ] || [ ! -f "$tarball" ]; then
  echo "smoke-test: pass the path to a packed .tgz" >&2
  exit 1
fi
tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"

fail() {
  echo "smoke-test: $*" >&2
  exit 1
}

echo "smoke-test: checking the file list of $(basename "$tarball")"
contents="$(tar -tzf "$tarball" | grep -v '/$' | sort)"
expected_fixed="package/LICENSE
package/README.md
package/dist/index.js
package/package.json
package/schema/public-api.graphql"
unexpected="$(printf '%s\n' "$contents" | grep -vxF "$expected_fixed" | grep -vxF package/CHANGELOG.md |
  grep -vE '^package/dist/main-[A-Za-z0-9_-]+\.js$' || true)"
[ -z "$unexpected" ] || fail "unexpected files in the tarball:
$unexpected"
for file in $expected_fixed; do
  printf '%s\n' "$contents" | grep -qxF "$file" || fail "missing $file"
done
[ "$(printf '%s\n' "$contents" | grep -cE '^package/dist/main-[A-Za-z0-9_-]+\.js$')" = "1" ] ||
  fail "expected exactly one dist/main-*.js chunk"

version="$(tar -xOzf "$tarball" package/package.json | jq -r .version)"
[ -n "$version" ] && [ "$version" != "null" ] || fail "cannot read the version from package.json"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/project" "$work/home"

echo "smoke-test: installing into an empty project"
(
  cd "$work/project"
  npm init -y >/dev/null
  npm install --no-audit --no-fund --loglevel=error "$tarball" >/dev/null
)

bin="$work/project/node_modules/.bin/gantry"
[ -x "$bin" ] || fail "the gantry bin was not installed"

run() {
  env -i PATH="$PATH" HOME="$work/home" CI=true "$bin" "$@"
}

echo "smoke-test: gantry --version"
reported="$(run --version)"
[ "$reported" = "$version" ] || fail "--version printed '$reported', expected '$version'"

echo "smoke-test: gantry --help"
run --help | grep -q '^Usage: gantry' || fail "--help did not print usage"

echo "smoke-test: gantry deployments --help"
run deployments --help | grep -q '^Usage: gantry deployments' || fail "deployments --help did not print usage"

echo "smoke-test: gantry validate with no config fails cleanly"
if (cd "$work/project" && run validate >/dev/null 2>&1); then
  fail "validate succeeded without a gantry.yml"
fi

echo "smoke-test: ok ($version)"
