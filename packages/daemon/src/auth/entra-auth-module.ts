import { type AppRole, AuthError, type JwtPayload } from '@autopod/shared';
import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import type { Logger } from 'pino';

const APP_ROLES = new Set<AppRole>(['admin', 'operator', 'viewer']);

interface EntraJwtClaims extends JWTPayload {
  oid?: string;
  tid?: string;
  preferred_username?: string;
  upn?: string;
  email?: string;
  name?: string;
  roles?: unknown;
}

export interface EntraAuthModuleConfig {
  tenantId: string;
  clientId: string;
  acceptedAudiences?: string[];
  issuers?: string[];
  jwks?: JWTVerifyGetKey;
  logger?: Logger;
}

export function defaultEntraAudiences(clientId: string): string[] {
  return [`api://${clientId}`, clientId, 'api://autopod'];
}

export function defaultEntraIssuers(tenantId: string): string[] {
  return [
    `https://login.microsoftonline.com/${tenantId}/v2.0`,
    `https://sts.windows.net/${tenantId}/`,
  ];
}

export function createEntraAuthModule(config: EntraAuthModuleConfig) {
  const tenantId = normalizeRequired('tenantId', config.tenantId);
  const clientId = normalizeRequired('clientId', config.clientId);
  const audiences = uniqueNonEmpty(config.acceptedAudiences ?? defaultEntraAudiences(clientId));
  const issuers = uniqueNonEmpty(config.issuers ?? defaultEntraIssuers(tenantId));
  const jwks =
    config.jwks ??
    createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
    );

  config.logger?.info(
    {
      tenantId,
      clientId,
      audiences,
      issuers,
    },
    'Entra auth module configured',
  );

  return {
    async validateToken(token: string): Promise<JwtPayload> {
      if (!token) throw new AuthError('Missing token');

      try {
        const { payload } = await jwtVerify<EntraJwtClaims>(token, jwks, {
          audience: audiences,
          issuer: issuers,
          clockTolerance: '60s',
        });

        if (payload.tid && payload.tid.toLowerCase() !== tenantId.toLowerCase()) {
          throw new AuthError('Token tenant does not match configured tenant');
        }

        return mapClaims(payload);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        config.logger?.debug({ err }, 'Entra token validation failed');
        throw new AuthError('Invalid authorization token');
      }
    },

    validateTokenSync(): JwtPayload {
      throw new AuthError('Entra token validation requires async verification');
    },
  };
}

function mapClaims(payload: EntraJwtClaims): JwtPayload {
  const oid = stringClaim(payload.oid) ?? stringClaim(payload.sub);
  if (!oid) throw new AuthError('Token is missing oid/sub claim');

  const username =
    stringClaim(payload.preferred_username) ??
    stringClaim(payload.upn) ??
    stringClaim(payload.email) ??
    oid;
  const name = stringClaim(payload.name) ?? username;
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (!aud) throw new AuthError('Token is missing audience claim');
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    throw new AuthError('Token is missing required time claims');
  }

  return {
    oid,
    preferred_username: username,
    name,
    roles: mapRoles(payload.roles),
    aud,
    iss: payload.iss ?? '',
    exp: payload.exp,
    iat: payload.iat,
  };
}

function mapRoles(raw: unknown): AppRole[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (role): role is AppRole => typeof role === 'string' && APP_ROLES.has(role as AppRole),
  );
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeRequired(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Missing Entra ${name}`);
  return normalized;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
