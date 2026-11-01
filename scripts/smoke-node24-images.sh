#!/usr/bin/env bash
# Run against an already built image; no publication, host mounts or daemon API.
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <node24|node24-pw|node24-pw-pg> <image-ref> [exact-node-version]" >&2
  exit 2
fi
template=$1
image=$2
expected_node=${3:-}
case "$template" in node24|node24-pw|node24-pw-pg) ;; *) exit 2 ;; esac
# Keep the native test aligned with the repository's existing dependency.
sqlite_version=$(node -p "require('./packages/daemon/node_modules/better-sqlite3/package.json').version")
docker image inspect "$image" --format '{{.Id}} {{json .RepoDigests}}'
docker run --rm -i --platform linux/amd64 --entrypoint bash \
  -e TEMPLATE="$template" -e EXPECTED_NODE="$expected_node" \
  -e SQLITE_VERSION="$sqlite_version" "$image" -se <<'SMOKE'
set -euo pipefail
test "$(id -u)" = 1000
test "$(id -un)" = autopod
node --version
node -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1); if (process.env.EXPECTED_NODE && process.versions.node !== process.env.EXPECTED_NODE) throw Error("Exact Node pin mismatch")'
for cli in pnpm claude codex copilot pi; do command -v "$cli"; done
pnpm --version
codex --version
pi --version
test -f "$(npm root -g)/@autopod/pi-worker/dist/index.js"
test "$npm_config_nodedir" = /usr/local
# Force a real source build with bundled headers, rather than using a prebuild.
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm_config_build_from_source=true npm install --no-audit --no-fund "better-sqlite3@$SQLITE_VERSION"
node -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); if (db.prepare("select 42 as n").get().n !== 42) process.exit(1); db.close();'
if [[ "$TEMPLATE" == *-pw* ]]; then
  node -e 'const { chromium } = require("playwright"); (async () => { const b = await chromium.launch(); const p = await b.newPage(); await p.setContent("<title>Node24 smoke</title>"); if (await p.title() !== "Node24 smoke") throw Error("browser failed"); await b.close(); })().catch(e => { console.error(e); process.exit(1); });'
fi
if [[ "$TEMPLATE" == *-pg ]]; then
  command -v jq
  test "$PGHOST" = 127.0.0.1
  test "$PGPORT" = 5433
  export PGDATA="$work/pgdata"
  trap 'pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || :; rm -rf -- "$work"' EXIT
  initdb -D "$PGDATA" -U postgres --auth=trust
  grep -Fx "unix_socket_directories = ''" "$PGDATA/postgresql.conf"
  pg_ctl -D "$PGDATA" -l "$work/postgres.log" -w start
  createdb -U postgres smoke
  psql -U postgres -d smoke -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pgcrypto; CREATE TABLE proof(n int); INSERT INTO proof VALUES (42);'
  pg_ctl -D "$PGDATA" -m fast -w stop
  pg_ctl -D "$PGDATA" -l "$work/postgres.log" -w start
  test "$(psql -U postgres -d smoke -Atc 'SELECT n FROM proof')" = 42
  pg_ctl -D "$PGDATA" -m fast -w stop
fi
SMOKE
