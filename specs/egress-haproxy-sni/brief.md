# Brief: Egress Allowlist via HAProxy SNI

## Objective

Replace the dnsmasq + ipset (with CIDR fallback) restricted-mode firewall in
`docker-network-manager.ts` with a single HAProxy SNI-based egress proxy inside
each pod container. The current mechanism has two unfixable failure modes:

1. **xt_set unavailable on Docker Desktop's LinuxKit kernel** — the runtime
   probes for ipset support, silently falls back to a CIDR snapshot, and pods
   on Docker Desktop run with a stale IP allowlist that can't track Anthropic /
   Azure CDN edge churn.
2. **CIDR fallback drifts** — Anthropic, Azure CDN, NuGet, and npm rotate
   front-end IPs faster than a one-shot DNS resolution snapshot survives. The
   policy is correct at `t=0` and wrong by `t+5min`.

HAProxy in TCP mode with a TLS SNI ACL enforces on the ClientHello hostname,
which is what the agent actually intended. No IP churn, no kernel module
dependency, one code path for every Docker host.

This is a **clean break** — the dnsmasq / ipset / CIDR-fallback paths are
deleted. Restricted mode is HTTPS-only (port 80 dropped). DNS uses the
container's host resolver; HAProxy is the sole allowlist.

## Files

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/containers/docker-network-manager.ts` | rewrite `generateFirewallScript()` for `restricted` mode; delete dnsmasq/ipset probe + branches | `allow-all` and `deny-all` modes unchanged. Restricted mode collapses from ~430 lines (lines 418–760-ish) to ~80 lines. |
| `packages/daemon/src/containers/docker-network-manager.test.ts` | rewrite `restricted` mode tests for the new shape | Keep `allow-all` / `deny-all` tests. Drop ipset / xt_set probe tests entirely. |
| `packages/daemon/src/containers/haproxy-config.ts` | create | Pure function `generateHaproxyConfig(allowedHosts: string[], denyLogSinkFd: number): string`. No side effects. |
| `packages/daemon/src/containers/haproxy-config.test.ts` | create | Cover: exact host → `req.ssl_sni -m str`, wildcard `*.foo.com` → `req.ssl_sni -m end .foo.com`, deterministic output for stable diffs, deny ACL ordering. |
| `packages/daemon/src/containers/haproxy-deny-parser.ts` | create | Parses HAProxy stdout for `HAPROXY-DENY sni=<host>` lines → `{ sni, timestamp }`. ~30 lines. |
| `packages/daemon/src/containers/haproxy-deny-parser.test.ts` | create | Fixture lines including malformed entries (drop silently, never throw). |
| `packages/daemon/src/containers/docker-container-manager.ts` | modify | In `streamLogs()` consumer or pod-manager's log pump, pipe stderr through the deny parser and emit `firewall.denied` events on the pod event bus. |
| `packages/daemon/src/pods/event-bus.ts` | modify | Add `firewall.denied` event type: `{ podId: string, sni: string, at: string }`. |
| `packages/shared/src/types/events.ts` | modify | Add the new event variant to the union so the WebSocket payload type covers it. |
| `packages/shared/src/types/analytics.ts` | modify | Extend `SafetyEventKind` with `'firewall_deny'` and `SafetyEventSource` with `'firewall_haproxy'`. Existing aggregation queries (`countByKindInWindow`, `countBySourceInWindow`, `sparkline`, top-pods) pick up the new kind automatically with no SQL changes. |
| `packages/daemon/src/safety/safety-events-repository.test.ts` | modify | One new test: insert + query a `firewall_deny` event, assert it surfaces in `countByKindInWindow`. |
| `templates/base/Dockerfile.dotnet10` | modify | Replace `iptables ipset dnsmasq` with `iptables haproxy ca-certificates`. |
| `templates/base/Dockerfile.dotnet10-go` | modify | Same. |
| `templates/base/Dockerfile.dotnet9` | modify | Same. |
| `templates/base/Dockerfile.go124` | modify | Same. |
| `templates/base/Dockerfile.go124-pw` | modify | Same. |
| `templates/base/Dockerfile.node22` | modify | Same. |
| `templates/base/Dockerfile.node22-pw` | modify | Same. |
| `templates/base/Dockerfile.python-node` | modify | Same. |
| `templates/base/Dockerfile.python-node-pg` | modify | Same. |
| `templates/base/Dockerfile.python312` | modify | Same. |
| `scripts/docker-validate.sh` | modify | Add an egress assertion: spawn a restricted pod, `curl https://api.anthropic.com/v1/models` succeeds (TLS handshake), `curl https://evil.example.com` fails with TCP reset, `curl http://deb.debian.org` times out (port 80 blocked). |

**Not modified**:
- `packages/daemon/src/containers/aci-container-manager.ts` — ACI uses Azure's
  own network isolation; this spec doesn't apply. Separate follow-up if ACI
  needs equivalent enforcement.
- `Dockerfile` (daemon production image) — daemon is the control plane, not
  a pod; no HAProxy needed.
- `DEFAULT_ALLOWED_HOSTS` in `docker-network-manager.ts` — same allowlist,
  same wildcard semantics, different enforcement layer.

## Approach

### 1. Rewritten restricted-mode firewall script (`docker-network-manager.ts`)

The new `restricted` branch in `generateFirewallScript()` produces something
like:

```sh
#!/bin/sh
set -e

# Allow loopback + established
iptables -F OUTPUT 2>/dev/null || true
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS (host resolver via Docker default)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Allow daemon gateway (MCP escalation endpoint)
for _gw_ip in $(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u); do
  iptables -A OUTPUT -d "$_gw_ip" -j ACCEPT
done
# (optional explicit daemonGatewayIp ACCEPT, same as today)

# Allow sidecar IPs unconditionally on all ports (dagger, etc.)
# … one ACCEPT per extraAllowedIps entry …

# Drop port 80 entirely (HTTPS-only policy)
iptables -A OUTPUT -p tcp --dport 80 -j DROP

# Redirect outbound 443 → local HAProxy, EXCEPT for trusted IPs (loopback, sidecars).
# Uses a NAT custom chain so sidecars on port 443 (any HTTPS sidecar) bypass HAProxy.
# Without this, a connection to <sidecar-ip>:443 hits the nat REDIRECT before the
# filter-table ACCEPT for sidecar IPs ever runs — HAProxy would then fail the SNI
# ACL on the sidecar's hostname and reset the connection.
iptables -t nat -N AUTOPOD_REDIRECT
iptables -t nat -A AUTOPOD_REDIRECT -d 127.0.0.0/8 -j RETURN
# … one RETURN per extraAllowedIps entry, emitted from the generator …
# iptables -t nat -A AUTOPOD_REDIRECT -d "$_sidecar_ip" -j RETURN
iptables -t nat -A AUTOPOD_REDIRECT -j REDIRECT --to-ports 8443
iptables -t nat -A OUTPUT -p tcp --dport 443 -j AUTOPOD_REDIRECT

# Reject anything else outbound
iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable

# IPv6: deny all outbound (mirrors today)
ip6tables -F OUTPUT 2>/dev/null || true
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable

# Write HAProxy config and start it
cat > /etc/haproxy/haproxy.cfg <<'HAPROXY_EOF'
… generated by generateHaproxyConfig() …
HAPROXY_EOF
mkdir -p /var/run/haproxy
haproxy -f /etc/haproxy/haproxy.cfg -D -p /var/run/haproxy/haproxy.pid

echo "Firewall: restricted mode — HAProxy SNI allowlist active"
```

Reasoning:
- `iptables -t nat REDIRECT --to-ports 8443` only fires for outbound 443
  destined off-box (`! -d 127.0.0.0/8`), so HAProxy itself can still
  `connect()` to the real upstream over 443.
- HAProxy daemonises (`-D`) and writes a PID file so `refreshFirewall` can
  `haproxy -sf $(cat /var/run/haproxy/haproxy.pid)` for hitless reload.
- No probe step. No fallback. The Dockerfile guarantees HAProxy is installed.

### 2. HAProxy config generator (`haproxy-config.ts`)

```ts
export function generateHaproxyConfig(allowedHosts: string[]): string {
  const exact = allowedHosts.filter((h) => !h.startsWith('*.'));
  const wildcard = allowedHosts.filter((h) => h.startsWith('*.')).map((h) => h.slice(1)); // *.foo.com → .foo.com

  // Build ACLs. -m str for exact, -m end for suffix.
  // Hosts sorted for deterministic output (stable diffs in CI).
  const exactAcls = [...exact].sort().map((h) => `  acl allowed_sni req.ssl_sni -m str ${h}`);
  const wildcardAcls = [...wildcard].sort().map((s) => `  acl allowed_sni req.ssl_sni -m end ${s}`);

  return `
global
  log stdout format raw daemon
  maxconn 4096
  user haproxy
  group haproxy

defaults
  mode tcp
  log global
  option tcplog
  timeout connect 5s
  timeout client 30s
  timeout server 30s

resolvers default
  parse-resolv-conf
  resolve_retries 3
  timeout resolve 1s
  timeout retry 1s
  hold valid 10s

frontend tls-in
  bind 127.0.0.1:8443
  tcp-request inspect-delay 5s
  tcp-request content reject if !{ req.ssl_hello_type 1 }
${exactAcls.join('\n')}
${wildcardAcls.join('\n')}
  # Log the SNI on every deny — daemon parses these lines
  tcp-request content reject if !allowed_sni log-format "HAPROXY-DENY sni=%[req.ssl_sni] src=%ci"
  default_backend tls-passthrough

backend tls-passthrough
  server upstream 0.0.0.0:443 init-addr none resolvers default
  # SNI value chosen by client; we splice unmodified TLS through
`.trimStart();
}
```

Notes:
- HAProxy 2.4+ supports per-rule `log-format` on rejects (the syntax exists on
  every Debian-shipped HAProxy from bookworm forward — Debian bookworm ships
  2.6, trixie 2.8+). Verify on the actual base image during PR validation.
- The `tls-passthrough` backend uses `req.ssl_sni` as the upstream host name —
  no MITM; HAProxy just splices TCP through to `<sni>:443` using the
  container's resolver.
- Wildcard `*.foo.com` becomes suffix match `.foo.com`, mirroring dnsmasq's
  current `/foo.com/` semantics.

### 3. Deny parser (`haproxy-deny-parser.ts`)

```ts
const DENY_RE = /HAPROXY-DENY sni=(\S+) src=(\S+)/;

export function parseHaproxyDenyLine(line: string): { sni: string; src: string } | null {
  const m = line.match(DENY_RE);
  if (!m) return null;
  return { sni: m[1] ?? '', src: m[2] ?? '' };
}
```

The pod log pump in `docker-container-manager.ts` already reads container
stdout/stderr — feed each line through the parser and emit a `firewall.denied`
event when it matches. Empty SNI (`-`) still gets surfaced — it means the
agent connected to an IP literal or non-TLS traffic on 443.

### 4. Event surface — dual-emit

Each HAProxy deny line becomes **two** outputs:

**(a) Live event-bus emit** for CLI / desktop observability. Add to the
`SystemEvent` union in `packages/shared/src/types/events.ts`:

```ts
| { kind: 'firewall.denied'; podId: string; sni: string; src: string; at: string }
```

`pod-manager.ts` already wires container log streams into the event bus —
extend that pump, not the runtime stream parser. `ap watch` and the desktop's
pod terminal pick it up automatically.

**(b) Analytics insert** into the existing `safety_events` table. Today's
dnsmasq denials never landed in `safety_events` — they were a `logger.warn()`
and nothing more. The HAProxy rework closes that gap so the existing
`safety-events-repository` aggregations cover firewall denials by default.

Extend the unions in `packages/shared/src/types/analytics.ts`:

```ts
export type SafetyEventKind = 'pii' | 'injection' | 'firewall_deny';
export type SafetyEventSource =
  | 'action_response' | 'mcp_proxy' | 'issue_body'
  | 'claude_md_section' | 'skill_content' | 'pod_input' | 'event_payload'
  | 'firewall_haproxy';
```

In the same log-pump where the bus event is emitted, also call:

```ts
safetyEventsRepo.insert({
  podId,
  kind: 'firewall_deny',
  source: 'firewall_haproxy',
  patternName: sni,           // the denied hostname is the "pattern"
  severity: null,             // binary block, no score
  payloadExcerpt: null,       // no payload — TCP reset is pre-data
});
```

No SQL migration needed — the table already accepts arbitrary string values
for `kind`, `source`, and `pattern_name`. Existing query surface
(`countByKindInWindow`, `countBySourceInWindow`, `countByPodInWindow`,
`sparkline`) starts including firewall denials immediately.

If `topInjectionsForPod` should become a more generic
`topSafetyEventsForPod(podId, kind?)`, that's a separate follow-up — flagged
in non-goals below.

### 5. Dockerfile changes

Each base image's `apt-get install` line that currently reads:

```
iptables ipset dnsmasq …
```

becomes:

```
iptables haproxy ca-certificates …
```

Specifically `Dockerfile.python-node` line 10 today reads
`iptables ipset dnsmasq` — same edit shape across all 10 templates. Confirm
the resulting image still includes `iptables-legacy` symlinks or whatever
the existing setup relies on; HAProxy package alone pulls a `haproxy` user,
which is what the firewall script's `-sf` reload depends on.

### 6. Tests

**Unit (`docker-network-manager.test.ts`)** — replace today's restricted-mode
tests with:
- restricted mode: generated script contains `--dport 443 … REDIRECT`,
  `--dport 80 … DROP`, no references to `dnsmasq`/`ipset`, HAProxy heredoc
  embedded
- restricted mode + `extraAllowedIps`: explicit ACCEPT rules emitted before
  the final REJECT, AND each sidecar IP gets a `-A AUTOPOD_REDIRECT -d <ip> -j RETURN`
  emitted before the final REDIRECT
- restricted mode: HAProxy config block present and non-empty
- restricted mode: deny log line emitted on stdout uses the
  `HAPROXY-DENY sni=… src=…` format expected by the parser

**Unit (`haproxy-config.test.ts`)** — new file:
- exact host `api.anthropic.com` → `acl allowed_sni req.ssl_sni -m str api.anthropic.com`
- wildcard `*.blob.core.windows.net` → `acl allowed_sni req.ssl_sni -m end .blob.core.windows.net`
- output is byte-identical for the same input twice (deterministic ordering)
- empty allowlist still parses (HAProxy rejects everything; valid config)

**Unit (`haproxy-deny-parser.test.ts`)** — new file:
- well-formed line → `{ sni, src }`
- malformed line → `null`
- empty SNI (`sni=-`) → `{ sni: '-', src: '…' }`

**Integration (`scripts/docker-validate.sh`)** — extend the existing smoke
script. With a restricted-mode pod alive:
- `docker exec pod curl -sS --max-time 5 https://api.anthropic.com/v1/models` exits
  non-zero (401 from the API is a successful network path; assert `curl` itself
  didn't fail with `Couldn't connect`)
- `docker exec pod curl -sS --max-time 5 https://evil.example.com` fails with a
  connection error
- `docker exec pod curl -sS --max-time 5 http://deb.debian.org` times out
- `docker exec pod sh -c 'cat /var/log/firewall-denied || journalctl …'` — or
  read daemon's WebSocket event stream — shows the `firewall.denied` event for
  `evil.example.com`

### 7. Live policy refresh

`docker-network-manager.refreshFirewall()` today re-execs the firewall script.
The new script:
1. Rewrites `/etc/haproxy/haproxy.cfg` with the new allowlist
2. `haproxy -f /etc/haproxy/haproxy.cfg -sf $(cat /var/run/haproxy/haproxy.pid)`
   — soft-reloads, drains existing sessions to the old process, accepts new
   sessions on the new one
3. Re-applies iptables rules (idempotent; flush + reinsert as today)

Existing tests for live refresh stay valid in shape; they just assert against
a different script body.

## Edge cases

- **IP-literal HTTPS targets** (`curl https://1.2.3.4`): no SNI in
  ClientHello → HAProxy rejects. Same posture as today (IP literals never
  worked with dnsmasq either).
- **HTTP/2 ALPN, WebSockets, gRPC over HTTPS**: HAProxy `mode tcp` with SNI
  splice is protocol-agnostic. ALPN, ALPN-fallback, and HTTP/2 frames all
  pass through unmodified.
- **No SNI extension** (very old TLS clients): `req.ssl_hello_type 1` ACL
  rejects pre-handshake. Empty `req.ssl_sni` doesn't match any allowlist
  entry, so it's also rejected by the main ACL. Both safety nets are needed.
- **Mid-pod allowlist change** (`refreshFirewall`): hitless via `haproxy -sf`.
  In-flight connections to a host that was just removed from the allowlist
  finish gracefully on the old process, then it exits.
- **Docker Desktop / LinuxKit**: no `xt_set` dependency at all. HAProxy +
  `iptables -t nat REDIRECT` works on any kernel with NAT support, which is
  every Docker host we support.
- **Sidecars (dagger, postgres)**: two layers — `AUTOPOD_REDIRECT` chain
  RETURNs for each sidecar IP so port-443 traffic skips HAProxy, AND the
  filter table has an explicit ACCEPT on all ports. Trusted because the
  daemon created the sidecar and knows its IP. Same trust model as today.
  Security analysis of the bypass under a rogue-agent threat model: zero new
  attack surface vs. the dnsmasq+ipset implementation. The agent can send
  arbitrary bytes to a sidecar IP, but the sidecar's own protocol stack is
  the boundary; sidecar pivot to the internet requires the sidecar itself
  to proxy arbitrary traffic (dagger/postgres do not — operator-added
  proxy sidecars are a config concern, not a firewall regression);
  sidecar IPs are per-pod-bridge and not routable from other pods or the
  host; agent can't modify HAProxy or flush iptables (different UID +
  `no-new-privileges` + no CAP_NET_ADMIN); forged SNI to a sidecar IP just
  hits a non-443 listener and dies.
- **MCP gateway**: daemon runs on `host.docker.internal:3100` (plain HTTP,
  not TLS). Gateway-IP ACCEPT in the filter table allows all ports to the
  gateway, including 3100. No interaction with HAProxy — it never sees this
  traffic. Identical posture to today; verified the port-80 DROP doesn't
  accidentally hit it (3100 ≠ 80).
- **apt-get at runtime against deb.debian.org**: blocked. Documented
  non-goal; system packages must be installed at image build time. If a pod
  truly needs runtime apt, the operator uses `allow-all` mode.
- **HAProxy process killed by OOM or bug**: pod loses outbound 443
  entirely. Add a `tini` reaper or restart loop? **Defer** — same single
  point of failure as today's dnsmasq; not a regression.

## Implementation notes

- **Order of commits suggested**:
  1. Add `haproxy-config.ts` + tests (pure function, fastest feedback)
  2. Add `haproxy-deny-parser.ts` + tests
  3. Add `firewall.denied` to the event union (shared + daemon types)
  4. Rewrite `docker-network-manager.ts` restricted-mode script + tests
  5. Wire deny parser into the pod log pump
  6. Update all 10 base Dockerfiles in one commit
  7. Extend `docker-validate.sh` smoke assertions
- **Biome style**: 2-space indent, 100-char lines, single quotes, trailing commas.
- **Do NOT keep dnsmasq / ipset / xt_set / SAFE_HOST_REGEX-as-CIDR code paths**
  — the file should be ~400 lines lighter when done.
- **Verify the `haproxy` package's default user/group exists in Debian
  bookworm slim** (it does — `/etc/passwd` entry is created by the postinst).
- **Container start order**: firewall script runs as PID 1 entrypoint glue,
  starts HAProxy, then `exec`s the agent CLI as `autopod`. The agent never
  has CAP_NET_ADMIN; HAProxy was already started before the drop.

## Skill references

- `/prep` produced this brief — single-pod task (one concern: egress
  enforcement mechanism). No `/plan-feature` series needed; the touched
  surfaces are tightly coupled and ship together.
- No `/add-profile-field` (no new profile fields — `networkPolicy` mode and
  `allowedHosts` are unchanged).
- No `/add-pod-state` (no new pod statuses — pods still go through `running`).

## Acceptance criteria

- [ ] `restricted` mode firewall script contains no references to `dnsmasq`,
      `ipset`, or `xt_set`. Verified by `docker-network-manager.test.ts`.
- [ ] `iptables -t nat -A OUTPUT -p tcp --dport 443 -j AUTOPOD_REDIRECT`
      present in restricted-mode output, with the `AUTOPOD_REDIRECT` chain
      RETURNing for loopback and each `extraAllowedIps` entry before its
      final `REDIRECT --to-ports 8443`. Verified by a test asserting that
      a configured sidecar IP gets a `RETURN` rule emitted.
- [ ] `iptables -A OUTPUT -p tcp --dport 80 -j DROP` present in
      restricted-mode output.
- [ ] `generateHaproxyConfig()` produces a config with one ACL per allowed
      host, exact hosts use `-m str`, wildcard hosts use `-m end .suffix`.
      Output is deterministic across runs.
- [ ] `parseHaproxyDenyLine()` extracts `{ sni, src }` from real HAProxy
      stdout, returns `null` on malformed input, never throws.
- [ ] Pod event bus emits `firewall.denied` events when HAProxy logs deny
      lines; events appear on the WebSocket stream consumed by CLI/desktop.
- [ ] Each deny also inserts a row into `safety_events` with
      `kind='firewall_deny'`, `source='firewall_haproxy'`, `pattern_name=<sni>`,
      `pod_id=<podId>`. `countByKindInWindow(7)` returns the new kind
      alongside `pii` / `injection`.
- [ ] No migration added — the new analytics values are pure type-union
      extensions; existing `safety_events` schema accepts them as-is.
- [ ] `NetworkPolicy` profile schema is unchanged. No new fields, no new
      modes, no new validator rules. ACI restriction
      (`profile-validator.ts:265-277`) is unaffected. Verified by running
      the existing profile-validator test suite without edits.
- [ ] All 10 `templates/base/Dockerfile.*` files install `haproxy` and no
      longer install `dnsmasq` or `ipset`.
- [ ] `docker-validate.sh` end-to-end smoke: allowed SNI succeeds, denied SNI
      gets TCP reset, port 80 outbound times out, `firewall.denied` event is
      observed for the denied SNI.
- [ ] `refreshFirewall()` reloads HAProxy via `-sf` without dropping
      in-flight connections to still-allowed hosts (manual verification —
      curl --keepalive against an allowed host during a refresh).
- [ ] `./scripts/validate.sh` passes (lint, build, all unit tests green).
- [ ] CHANGELOG entry documents the clean break: self-built images without
      `haproxy` installed will fail at firewall apply time with a clear error.

## Estimated scope

Files: 24 (1 large rewrite, 4 new TS modules, 5 type / repo-test edits, 10
Dockerfile edits, 1 shell script, 1 spec, 2 changelog/docs) | Complexity:
medium | Time: 5–7 hrs

The long pole is `docker-validate.sh` running end-to-end against a real
container — image rebuild + curl-based assertions. Everything else is
mechanical given the design above.
