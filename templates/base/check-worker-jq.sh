#!/bin/sh
# Build-time qualification of distro jq, run as the configured worker.
set -eu

test "$(id -u)" -ne 0
# Use the package-owned binary rather than a PATH-local substitute.
test "$(dpkg-query -W -f='${Status}' jq)" = 'install ok installed'
result=$(printf '%s\n' '{"items":[{"name":"skip","enabled":false},{"name":"worker","enabled":true}]}' \
    | /usr/bin/jq -ce '{names: [.items[] | select(.enabled) | .name], count: (.items | length)}')
test "$result" = '{"names":["worker"],"count":2}'
printf '%s\n' "$result" | /usr/bin/jq -e '.count == 2 and .names == ["worker"]' >/dev/null
for value in false null; do
    status=0
    printf '%s\n' "$value" | /usr/bin/jq -e '.' >/dev/null || status=$?
    test "$status" -eq 1
done
