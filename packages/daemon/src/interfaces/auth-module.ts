import type { JwtPayload } from '@autopod/shared';

export interface AuthModule {
  validateToken(token: string): Promise<JwtPayload>;
  /**
   * Legacy/testing hook. Real Entra validation is async because the daemon
   * resolves signing keys from JWKS.
   */
  validateTokenSync?(token: string): JwtPayload;
}
