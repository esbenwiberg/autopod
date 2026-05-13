/**
 * Parses HAProxy syslog lines emitted by the restricted-mode egress
 * proxy. The frontend's `log-format` (see `haproxy-config.ts`) renders:
 *
 *   sni=<host-or-empty> src=<client-ip> action=ALLOW|DENY
 *
 * which arrives wrapped in a syslog envelope, e.g.
 *
 *   <134>May 12 20:47:25 haproxy[8595]: sni=evil.example.com src=127.0.0.1 action=DENY
 *
 * The parser is tolerant: malformed lines, partial buffers, and unknown
 * actions return `null` rather than throwing. The daemon's log pump
 * processes every container stdout line, so any cost is paid per line.
 */

const HAPROXY_LINE_RE = /sni=(\S+) src=(\S+) action=(\w+)/;

export interface HaproxyLogEntry {
  sni: string;
  src: string;
  action: 'ALLOW' | 'DENY';
}

export function parseHaproxyLogLine(line: string): HaproxyLogEntry | null {
  const match = line.match(HAPROXY_LINE_RE);
  if (!match) return null;
  const [, sni, src, action] = match;
  if (action !== 'ALLOW' && action !== 'DENY') return null;
  return { sni: sni ?? '', src: src ?? '', action };
}
