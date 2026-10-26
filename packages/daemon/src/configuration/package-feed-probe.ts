import type { ConfigurationPayloads } from '@autopod/shared';
import { fetchWithTimeout, readSafeJson, withAbort } from '../actions/handlers/handler.js';
import { createPinnedHttpTransport } from '../actions/pinned-http-transport.js';
import { assertPublicUrl } from '../api/ssrf-guard.js';

export type FeedProbeStatus =
  | 'authenticated'
  | 'rejected'
  | 'forbidden'
  | 'unverified'
  | 'unavailable';
export interface FeedProbeResult {
  status: FeedProbeStatus;
  message: string;
}
const messages: Record<FeedProbeStatus, string> = {
  authenticated: 'Authenticated read succeeded. This does not prove access to every package.',
  rejected: 'The feed rejected the credential (401).',
  forbidden: 'The feed denied access (403). Check feed permissions.',
  unverified:
    'This endpoint does not establish authenticated access. The credential has not been verified.',
  unavailable:
    'Connection test unavailable: destination policy, redirect, timeout, network or invalid response. No credential validity conclusion.',
};

/** No upstream body, identity, URL or error text is returned to the operator or logs. */
export async function probePackageFeed(
  feed: ConfigurationPayloads['packageFeed'],
  token: string,
  dependencies = { guard: assertPublicUrl, transport: createPinnedHttpTransport() },
): Promise<FeedProbeResult> {
  const result = (status: FeedProbeStatus): FeedProbeResult => ({
    status,
    message: messages[status],
  });
  try {
    const base = new URL(feed.url);
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      /[\r\n]/.test(token)
    )
      return result('unavailable');
    const url = feed.type === 'npm' ? `${feed.url.replace(/\/$/, '')}/-/whoami` : feed.url;
    const signal = AbortSignal.timeout(10_000);
    const request = (authenticated: boolean) =>
      fetchWithTimeout(
        url,
        {
          method: 'GET',
          redirect: 'manual',
          signal,
          timeout: 10_000,
          headers: {
            Accept: 'application/json',
            ...(authenticated
              ? {
                  Authorization:
                    feed.type === 'nuget' || base.hostname === 'pkgs.dev.azure.com'
                      ? `Basic ${Buffer.from(`autopod:${token}`).toString('base64')}`
                      : `Bearer ${token}`,
                }
              : {}),
          },
        },
        async (destination, init) => {
          const checked = await withAbort(dependencies.guard(destination), signal);
          if (!checked.ok || !checked.resolvedIps?.length) throw new Error('Blocked destination');
          return dependencies.transport(destination, init, checked.resolvedIps);
        },
      );
    // A public endpoint returning 200 is not evidence that a PAT is valid.
    const anonymous = await request(false);
    if (anonymous.status !== 401 && anonymous.status !== 403) return result('unverified');
    const response = await request(true);
    if (response.status === 401) return result('rejected');
    if (response.status === 403) return result('forbidden');
    if (response.status >= 300 && response.status < 400) return result('unavailable');
    if (!response.ok) return result('unverified');
    const body = await readSafeJson(response);
    if (!body || typeof body !== 'object') return result('unverified');
    if (feed.type === 'npm') {
      if (!('username' in body) || typeof body.username !== 'string' || !body.username)
        return result('unverified');
    } else if (!('resources' in body) || !Array.isArray(body.resources))
      return result('unverified');
    return result('authenticated');
  } catch {
    return result('unavailable');
  }
}
