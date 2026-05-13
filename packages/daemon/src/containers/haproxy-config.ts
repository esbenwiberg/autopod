/**
 * Generates the HAProxy configuration that enforces the restricted-mode
 * egress allowlist inside a pod container.
 *
 * HAProxy listens on `127.0.0.1:8443`; the firewall script redirects all
 * outbound port-443 traffic to it via iptables NAT. HAProxy inspects the
 * TLS ClientHello, accepts only allowlisted SNI values, resolves the SNI
 * to an IP, and splices the unmodified TLS bytes through to that
 * destination. No MITM — the certificate is end-to-end between the agent
 * and the upstream.
 *
 * Validated against HAProxy 2.8.16 (Ubuntu 24.04, same major as Debian
 * bookworm-backports / trixie). See specs/egress-haproxy-sni/brief.md
 * for the spike write-up.
 */

/**
 * Port HAProxy binds to inside the pod container. The firewall script
 * REDIRECTs outbound 443 here. Kept loopback-only so the agent cannot
 * connect to HAProxy directly with a fabricated source — only the
 * kernel's NAT path can hit this socket.
 */
export const HAPROXY_LISTEN_PORT = 8443;

/**
 * UDP port HAProxy writes its syslog stream to. The firewall script runs
 * a tiny receiver (FIFO + tail, see brief §3) that flushes lines into
 * the container's stdout, which the daemon's log pump consumes.
 */
export const HAPROXY_LOG_PORT = 5514;

export interface HaproxyConfigInput {
  /**
   * Host allowlist. Exact entries match the full SNI; entries starting
   * with `*.` become suffix matches on the dot-prefixed remainder
   * (e.g. `*.blob.core.windows.net` → `-m end .blob.core.windows.net`).
   */
  allowedHosts: string[];
}

/**
 * Build the HAProxy config text. Pure function — same input always
 * produces byte-identical output, which keeps CI diffs stable and makes
 * `haproxy -sf` reloads deterministic.
 */
export function generateHaproxyConfig(input: HaproxyConfigInput): string {
  const exact: string[] = [];
  const wildcardSuffix: string[] = [];

  for (const host of input.allowedHosts) {
    if (host.startsWith('*.')) {
      // `*.foo.com` → match SNI ending in `.foo.com`. Strip the `*`
      // but keep the leading dot so we don't accidentally match
      // `evilfoo.com`.
      wildcardSuffix.push(host.slice(1));
    } else {
      exact.push(host);
    }
  }

  // Sort for deterministic output.
  exact.sort();
  wildcardSuffix.sort();

  const acls: string[] = [];
  for (const host of exact) {
    acls.push(`  acl allowed_sni var(sess.sni) -m str ${host}`);
  }
  for (const suffix of wildcardSuffix) {
    acls.push(`  acl allowed_sni var(sess.sni) -m end ${suffix}`);
  }

  return `global
  log 127.0.0.1:${HAPROXY_LOG_PORT} local0
  maxconn 1024

defaults
  mode tcp
  log global
  option dontlognull
  timeout connect 5s
  timeout client 30s
  timeout server 30s

resolvers system
  parse-resolv-conf
  hold valid 10s
  hold nx 3s
  resolve_retries 2
  timeout resolve 1s
  timeout retry 1s

frontend tls-in
  bind 127.0.0.1:${HAPROXY_LISTEN_PORT}
  tcp-request inspect-delay 5s
  tcp-request content reject if !{ req.ssl_hello_type 1 }

  # Capture SNI into a session variable. req.ssl_sni is not available at
  # log-format eval time; the variable is.
  tcp-request content set-var(sess.sni) req.ssl_sni,lower

${acls.join('\n')}

  log-format "sni=%[var(sess.sni)] src=%ci action=%[var(sess.action)]"

  tcp-request content set-var(sess.action) str(DENY) if !allowed_sni
  tcp-request content reject if !allowed_sni
  tcp-request content set-var(sess.action) str(ALLOW)

  # Resolve SNI → IP and rewrite the destination. do-resolve returns
  # 0.0.0.0 on NXDOMAIN; reject in that case so we don't accidentally
  # connect to local 0.0.0.0:443.
  tcp-request content do-resolve(sess.dst_ip,system,ipv4) var(sess.sni)
  tcp-request content reject if { var(sess.dst_ip) -m ip 0.0.0.0 }
  tcp-request content set-dst var(sess.dst_ip)
  tcp-request content set-dst-port int(443)

  default_backend tls-passthrough

backend tls-passthrough
  server upstream 0.0.0.0:443
`;
}
