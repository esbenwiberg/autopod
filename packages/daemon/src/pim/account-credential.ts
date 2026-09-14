import type { PimAccountIdentity } from '@autopod/shared';
import { decodeJwt } from 'jose';
import type { Logger } from 'pino';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { getAzureToken } from '../providers/azure-token.js';
import type { PimAudience } from './api-client.js';

/** PIM uses the configured human account. Managed identity/service-principal fallback cannot activate. */
export function createPimAccountCredential(account: PimAccountIdentity, logger: Logger) {
  return async (audience: PimAudience): Promise<PimAccountIdentity & { token: string }> => {
    const resource =
      audience === 'graph' ? 'https://graph.microsoft.com' : 'https://management.azure.com';
    const acquired = await getAzureToken(`${resource}/.default`, logger, {
      tenantId: account.tenantId,
    });
    // This metadata is read only from the daemon's trusted credential acquisition, never a pod JWT.
    // Microsoft authenticates the actual bearer token on each fixed-origin request; /me additionally
    // confirms the user identity during eligibility discovery.
    let claims: { oid: string; tid: string; scp: string };
    try {
      claims = z
        .object({ oid: z.string().min(1), tid: z.string().min(1), scp: z.string().min(1) })
        .parse(decodeJwt(acquired.token));
    } catch {
      configurationError(
        'PIM requires a delegated token for the configured user account',
        'PIM_USER_ACCOUNT_REQUIRED',
        403,
      );
    }
    if (claims.oid !== account.principalId || claims.tid !== account.tenantId)
      configurationError(
        'PIM token belongs to a different account or tenant',
        'PIM_ACCOUNT_CHANGED',
        403,
      );
    return { ...account, token: acquired.token };
  };
}
