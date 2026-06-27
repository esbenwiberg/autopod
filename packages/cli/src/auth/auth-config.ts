import type { CliConfig } from '../config/schema.js';

export interface ResolvedAuthConfig {
  clientId: string;
  tenantId: string;
  scopes: string[];
}

export function parseAuthScopes(value: string | string[] | undefined, clientId: string): string[] {
  if (!value || (Array.isArray(value) && value.length === 0)) {
    return [`api://${clientId}/access_as_user`];
  }

  const scopes = Array.isArray(value) ? value : value.split(',');
  return scopes.map((scope) => scope.trim()).filter(Boolean);
}

export function resolveAuthConfig(
  env: NodeJS.ProcessEnv,
  config: CliConfig,
): ResolvedAuthConfig | null {
  const clientId = env.AUTOPOD_CLIENT_ID ?? config.auth?.clientId;
  const tenantId = env.AUTOPOD_TENANT_ID ?? config.auth?.tenantId;
  if (!clientId || !tenantId) return null;

  return {
    clientId,
    tenantId,
    scopes: parseAuthScopes(env.AUTOPOD_AUTH_SCOPE ?? config.auth?.scopes, clientId),
  };
}
