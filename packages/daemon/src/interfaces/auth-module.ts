import type { JwtPayload } from '@autopod/shared';

export interface AuthModule {
  validateToken(token: string): Promise<JwtPayload>;
  validateTokenSync(token: string): JwtPayload;
}
