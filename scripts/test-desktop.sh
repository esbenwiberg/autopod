#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# AppKit/WebKit and offline HTTP fixtures share OS authentication-framework
# state within a process. Keep package test targets in separate processes;
# discover the complete inventory so new targets cannot silently be omitted.
test_inventory_dir="$(mktemp -d "${TMPDIR:-/tmp}/autopod-desktop-tests.XXXXXX")"
trap 'rm -f "$test_inventory_dir/inventory" "$test_inventory_dir/targets"; rmdir "$test_inventory_dir"' EXIT

swift test --package-path packages/desktop list > "$test_inventory_dir/inventory"
awk -F. '
  /^[A-Za-z_][A-Za-z0-9_]*\./ { print $1; count++; next }
  { print "Unrecognized Swift test inventory line: " $0 > "/dev/stderr"; exit 1 }
  END { if (!count) { print "Swift test inventory is empty" > "/dev/stderr"; exit 1 } }
' "$test_inventory_dir/inventory" | sort -u > "$test_inventory_dir/targets"

while IFS= read -r test_target; do
  printf 'Testing desktop target: %s\n' "$test_target"
  swift test --package-path packages/desktop --skip-build --no-parallel --filter "^${test_target}\\."
done < "$test_inventory_dir/targets"
