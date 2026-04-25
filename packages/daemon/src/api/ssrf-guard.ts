import { lookup } from 'node:dns/promises';

/**
 * SSRF guard.
 *
 * Two layers:
 *   1. `isPrivateUrl(url)` — synchronous hostname/IP-literal check. Catches the obvious
 *      attempt: `http://169.254.169.254/...` or `http://localhost/...`.
 *   2. `assertPublicUrl(url)` — async; resolves the hostname and rejects if **any**
 *      A/AAAA record points at a private/loopback/link-local/metadata range. Defeats
 *      the trivial DNS pointer attack ("evil.com → 169.254.169.254").
 *
 * Residual gap: a fully active DNS-rebinding attacker can still flip the record
 * between our pre-check and the actual `fetch()`. Closing that requires pinning
 * the IP into the request via a custom undici dispatcher; tracked as a follow-up.
 *
 * The hostname/IP rules below cover:
 *  - IPv4 loopback (127/8), this-network (0/8), private (10/8, 172.16/12, 192.168/16),
 *    link-local (169.254/16, includes AWS/GCP/Azure metadata 169.254.169.254),
 *    CGNAT (100.64/10).
 *  - IPv6 unspecified (::), loopback (::1), ULA (fc00::/7), link-local (fe80::/10),
 *    IPv4-mapped (::ffff:<v4>) with the embedded IPv4 re-validated.
 *  - Cloud metadata FQDNs (metadata.google.internal, etc.) and the reserved
 *    .internal / .local TLDs.
 */

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped IPv6 (::ffff:<v4>) — re-validate the embedded IPv4.
  const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped?.[1]) return isPrivateIPv4(v4mapped[1]);
  // ULA fc00::/7 — first byte is fc or fd.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // Link-local fe80::/10 — first 10 bits are 1111111010, so the first three hex
  // digits are fe[89ab].
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  return false;
}

/** Returns true for any private/loopback IPv4 or IPv6 literal. */
export function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

const METADATA_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.googleapis.com',
  'metadata.azure.com',
  'instance-data',
]);

/**
 * Reserved TLDs that resolve to private/internal infrastructure. `.internal` is
 * reserved by ICANN (2024) for private use; `.local` is reserved for mDNS.
 */
const PRIVATE_TLD_SUFFIXES = ['.internal', '.local', '.localhost'];

function isMetadataHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTNAMES.has(h)) return true;
  for (const suffix of PRIVATE_TLD_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Synchronous pattern check on the URL's hostname. Catches IP-literal SSRF
 * (`http://169.254.169.254/...`) and well-known metadata FQDNs without doing
 * a DNS lookup. Use as a fast pre-filter; pair with `assertPublicUrl` for
 * full coverage of "evil.com → 169.254.169.254" pointer attacks.
 */
export function isPrivateUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true; // malformed URL — block it
  }
  // URL.hostname for IPv6 literals includes brackets (e.g. "[::1]"); strip them
  // before per-protocol classification.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return true;
  if (isMetadataHostname(hostname)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return isPrivateIPv4(hostname);
  if (hostname.includes(':')) return isPrivateIPv6(hostname);
  return false;
}

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
  /** All IP records the hostname resolved to. Useful for diagnostic logging. */
  resolvedIps?: string[];
}

export interface SsrfGuardOptions {
  /** Inject a custom DNS resolver for tests. Defaults to node:dns/promises lookup. */
  resolver?: (hostname: string) => Promise<string[]>;
}

const defaultResolver = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/**
 * Validate that `rawUrl` points at a public address. Performs both the
 * synchronous hostname check and DNS resolution, returning `ok: false` if
 * any resolved record is in a private range.
 */
export async function assertPublicUrl(
  rawUrl: string,
  opts: SsrfGuardOptions = {},
): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'malformed URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return { ok: false, reason: 'missing hostname' };

  if (isPrivateUrl(rawUrl)) {
    return { ok: false, reason: `hostname is private/metadata: ${hostname}` };
  }

  // If the hostname is already an IP literal, isPrivateUrl above handled it
  // and returned false here — no need to resolve.
  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':');
  if (isIpLiteral) return { ok: true, resolvedIps: [hostname] };

  const resolver = opts.resolver ?? defaultResolver;
  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `DNS resolution failed: ${message}` };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'DNS returned no records' };
  }

  for (const address of addresses) {
    if (isPrivateIp(address)) {
      return { ok: false, reason: `resolved to private address: ${address}` };
    }
  }

  return { ok: true, resolvedIps: addresses };
}
