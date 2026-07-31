#!/bin/sh
set -eu

real_initdb=/usr/lib/postgresql/17/bin/initdb
pgdata=
expect_pgdata=0

for arg in "$@"; do
  if [ "$expect_pgdata" -eq 1 ]; then
    pgdata=$arg
    expect_pgdata=0
    continue
  fi
  case "$arg" in
    -D|--pgdata) expect_pgdata=1 ;;
    -D?*) pgdata=${arg#-D} ;;
    --pgdata=*) pgdata=${arg#--pgdata=} ;;
  esac
done

"$real_initdb" "$@"

config=
if [ -n "$pgdata" ] && [ -f "$pgdata/postgresql.conf" ]; then
  config=$pgdata/postgresql.conf
else
  for arg in "$@"; do
    if [ -f "$arg/postgresql.conf" ]; then
      config=$arg/postgresql.conf
    fi
  done
  if [ -z "$config" ] && [ -n "${PGDATA:-}" ] && [ -f "$PGDATA/postgresql.conf" ]; then
    config=$PGDATA/postgresql.conf
  fi
fi

# Preserve informational invocations such as --version, which create no cluster.
[ -n "$config" ] || exit 0
if ! grep -Fxq "unix_socket_directories = ''" "$config"; then
  printf "\n# Autopod transient clusters are TCP-only.\nunix_socket_directories = ''\n" >> "$config"
fi
