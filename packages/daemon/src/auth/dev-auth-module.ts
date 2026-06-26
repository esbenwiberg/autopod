import { AuthError, type JwtPayload } from '@autopod/shared';
import type { AuthModule } from '../interfaces/index.js';

export interface DevAuthModuleConfig {
  allowDevAuth: boolean;
  devToken: string | null | undefined;
  isDev: boolean;
}

export function createDevAuthModule(config: DevAuthModuleConfig): AuthModule {
  const validate = (token: string): JwtPayload => {
    if (!config.allowDevAuth) {
      throw new AuthError(
        config.isDev
          ? 'Dev auth not enabled — set AUTOPOD_ALLOW_DEV_AUTH=1'
          : 'Auth module not configured',
      );
    }
    if (!token) {
      throw new AuthError('Missing token');
    }
    if (!config.devToken || token !== config.devToken) {
      throw new AuthError('Invalid dev auth token');
    }
    return devPayload();
  };

  return {
    async validateToken(token: string) {
      return validate(token);
    },
    validateTokenSync(token: string) {
      return validate(token);
    },
  };
}

function devPayload(): JwtPayload {
  return {
    oid: 'dev-user',
    preferred_username: 'developer',
    name: 'Developer',
    roles: ['admin'],
    aud: 'autopod',
    iss: 'autopod-dev',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };
}
