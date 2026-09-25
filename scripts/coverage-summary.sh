#!/usr/bin/env bash
# Renders coverage/coverage-summary.json (from `npm run test:coverage`) as Markdown,
# for the GitHub Actions job summary.
#
# Usage: scripts/coverage-summary.sh [path/to/coverage-summary.json] >> "$GITHUB_STEP_SUMMARY"
set -euo pipefail

summary="${1:-coverage/coverage-summary.json}"
# Mirrors the 80% floor in vitest.config.ts; used only for the status column here.
floor="${COVERAGE_FLOOR:-80}"

if [ ! -f "$summary" ]; then
  echo "coverage-summary: $summary not found. Run \`npm run test:coverage\` first." >&2
  exit 1
fi

root="$(pwd)/"

jq -r --arg floor "$floor" --arg root "$root" '
  def status(p): if p >= ($floor | tonumber) then "✅" else "❌" end;
  def cell(m): "\(m.pct)% (\(m.covered)/\(m.total))";

  "## Coverage",
  "",
  "| Metric | Coverage | Floor | |",
  "|---|---|---|---|",
  (.total | to_entries[]
    | select(.key | IN("lines", "branches", "functions", "statements"))
    | "| \(.key) | \(cell(.value)) | \($floor)% | \(status(.value.pct)) |"),
  "",
  "<details><summary>Per file, lowest line coverage first</summary>",
  "",
  "| File | Lines | Branches | Functions | Statements |",
  "|---|---|---|---|---|",
  (to_entries
    | map(select(.key != "total"))
    | sort_by(.value.lines.pct, .value.branches.pct, .key)[]
    | "| `\(.key | ltrimstr($root))` | \(.value.lines.pct)% | \(.value.branches.pct)% | \(.value.functions.pct)% | \(.value.statements.pct)% |"),
  "",
  "</details>"
' "$summary"
