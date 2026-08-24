import type { Logger } from 'pino';
import { getAzureToken } from './azure-token.js';

/** Azure DevOps' first-party Entra application/resource ID. */
export const AZURE_DEVOPS_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export interface AzureDevOpsAuth {
  getToken(): Promise<string>;
}

export interface AzureDevOpsAuthOptions {
  /** Tenant that owns the Azure DevOps organization. */
  tenantId?: string;
}

/**
 * Canonical Azure DevOps credential source for the daemon.
 *
 * `getAzureToken` prefers the daemon service account's Azure CLI session and
 * falls back to managed identity. Its cache refreshes before expiry, so every
 * ADO caller can request a fresh-enough token at operation time.
 */
export function createAzureDevOpsAuth(
  logger: Logger,
  options: AzureDevOpsAuthOptions = {},
): AzureDevOpsAuth {
  return {
    async getToken(): Promise<string> {
      const tenantId = options.tenantId?.trim();
      const result = tenantId
        ? await getAzureToken(AZURE_DEVOPS_SCOPE, logger, { tenantId })
        : await getAzureToken(AZURE_DEVOPS_SCOPE, logger);
      return result.token;
    },
  };
}
