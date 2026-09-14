import type { ConfigurationCredentialPurpose } from '@autopod/shared';
import { configurationError } from './configuration-store.js';

const sourceHost = (host: string) =>
  host === 'github.com' ||
  host.endsWith('.github.com') ||
  host === 'dev.azure.com' ||
  host.endsWith('.visualstudio.com');

/** Operator enrollment is the service grant. This check cannot establish a token's provider scopes.
 * It prevents known source credentials (including this daemon's current delivery credentials)
 * from being repackaged as a service secret. Pods cannot call credential enrollment endpoints.
 */
export function createServiceCredentialBoundary(protectedCredentials: () => Promise<string[]>) {
  return async (value: string, _purposes: ConfigurationCredentialPurpose[], origins: string[]) => {
    if (!origins.length)
      configurationError(
        'Declare the service origin before enrolling its credential',
        'CONFIG_CREDENTIAL_SCOPE',
        403,
      );
    if (origins.some((origin) => sourceHost(new URL(origin).hostname)))
      configurationError(
        'Source service credentials belong to the daemon broker',
        'SOURCE_CREDENTIAL_FORBIDDEN',
        403,
      );
    const protectedValues = await protectedCredentials();
    const candidates = new Set<string>([value]);
    for (let depth = 0; depth < 3; depth++) {
      for (const candidate of [...candidates]) {
        for (const word of candidate.split(/[\s"',:{}]+/)) {
          if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(word)) {
            const decoded = Buffer.from(word, 'base64').toString('utf8');
            if (!decoded.includes('\ufffd')) candidates.add(decoded);
          }
        }
        try {
          candidates.add(decodeURIComponent(candidate));
        } catch {
          /* Not URL-encoded. */
        }
      }
    }
    if (
      [...candidates].some(
        (candidate) =>
          /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+|\b[a-f0-9]{40}\b|\b[A-Za-z0-9]{52}\b|\b[A-Za-z0-9]{75}AZDO[A-Za-z0-9]{5}\b/i.test(
            candidate,
          ) ||
          /499b84ac-1321-427f-aa17-267ca6975798|https:\/\/app\.vssps\.visualstudio\.com/.test(
            candidate,
          ) ||
          protectedValues.some((secret) => secret.length > 0 && candidate.includes(secret)),
      )
    )
      configurationError(
        'Source credentials cannot be injected into pods; use the daemon broker',
        'SOURCE_CREDENTIAL_FORBIDDEN',
        403,
      );
  };
}
