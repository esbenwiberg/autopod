#!/usr/bin/env bash
# PreToolUse hook: block creating a new migration file whose NNN_ prefix
# collides with an existing one.
#
# The migration runner (packages/daemon/src/db/migrate.ts) treats the numeric
# prefix as the schema version. Two files with the same prefix means the
# alphabetically-second one is silently skipped forever — the same class of
# bug that landed commit 0a89363 ("repair colliding 096 migration prefix").

set -euo pipefail

payload=$(cat)

tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // empty')
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

[ "$tool_name" = "Write" ] || exit 0

case "$file_path" in
  */packages/daemon/src/db/migrations/*.sql) ;;
  *) exit 0 ;;
esac

# Overwriting an existing file is allowed (same NNN by definition).
[ -e "$file_path" ] && exit 0

filename=$(basename "$file_path")
prefix=$(printf '%s' "$filename" | grep -oE '^[0-9]+' || true)

[ -z "$prefix" ] && exit 0  # Filename doesn't follow NNN_ convention

dir=$(dirname "$file_path")
collision=$(ls "$dir"/"$prefix"_*.sql 2>/dev/null | head -n 1 || true)

if [ -n "$collision" ]; then
  cat <<EOF >&2
🚫 Migration prefix collision

Trying to create:  $filename
Already exists:    $(basename "$collision")
Prefix:            $prefix

The migration runner uses the numeric prefix as the schema version. Two files
sharing a prefix is a silent bug — the alphabetically-second is skipped
forever (see commit 0a89363).

Pick the next free prefix. Latest 5:
$(ls "$dir" | tail -n 5 | sed 's/^/  /')
EOF
  exit 2
fi

exit 0
