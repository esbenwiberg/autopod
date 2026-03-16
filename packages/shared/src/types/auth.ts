export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  displayName: string;
  email: string;
  roles: AppRole[];
}

export type AppRole = 'admin' | 'operator' | 'viewer';

export interface JwtPayload {
  oid: string;
  preferred_username: string;
  name: string;
  roles: AppRole[];
  aud: string;
  iss: string;
  exp: number;
  iat: number;
}

export interface DaemonConnection {
  url: string;
  healthy: boolean;
  version: string;
  lastChecked: string;
}
