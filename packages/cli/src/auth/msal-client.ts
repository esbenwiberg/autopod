import type { AppRole, AuthToken } from '@autopod/shared';
import {
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type DeviceCodeRequest,
  PublicClientApplication,
  type SilentFlowRequest,
} from '@azure/msal-node';
import open from 'open';

const DEFAULT_SCOPES = ['api://autopod/.default'];

export class MsalClient {
  private pca: PublicClientApplication;
  private scopes: string[];

  constructor(clientId: string, tenantId: string, scopes: string[] = DEFAULT_SCOPES) {
    const config: Configuration = {
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    };
    this.pca = new PublicClientApplication(config);
    this.scopes = scopes.length ? scopes : DEFAULT_SCOPES;
  }

  async acquireTokenByDeviceCode(onMessage: (message: string) => void): Promise<AuthToken> {
    const request: DeviceCodeRequest = {
      scopes: this.scopes,
      deviceCodeCallback: (response) => {
        onMessage(response.message);
      },
    };

    const result = await this.pca.acquireTokenByDeviceCode(request);
    if (!result) {
      throw new Error('Device code flow returned null');
    }
    return this.mapResult(result);
  }

  async acquireTokenInteractive(): Promise<AuthToken> {
    // PKCE flow with local redirect
    const result = await this.pca.acquireTokenInteractive({
      scopes: this.scopes,
      openBrowser: async (url) => {
        await open(url);
      },
      successTemplate: '<h1>Authentication successful</h1><p>You can close this window.</p>',
      errorTemplate: '<h1>Authentication failed</h1><p>{{error}}</p>',
    });

    if (!result) {
      throw new Error('Interactive auth returned null');
    }
    return this.mapResult(result);
  }

  async refreshToken(account: AccountInfo): Promise<AuthToken | null> {
    const request: SilentFlowRequest = {
      scopes: this.scopes,
      account,
    };

    try {
      const result = await this.pca.acquireTokenSilent(request);
      if (!result) return null;
      return this.mapResult(result);
    } catch {
      return null;
    }
  }

  async getAccounts(): Promise<AccountInfo[]> {
    const cache = this.pca.getTokenCache();
    return cache.getAllAccounts();
  }

  private mapResult(result: AuthenticationResult): AuthToken {
    return {
      accessToken: result.accessToken,
      refreshToken: '', // MSAL manages refresh tokens internally
      expiresAt: result.expiresOn?.toISOString() ?? new Date(Date.now() + 3600_000).toISOString(),
      userId: result.account?.localAccountId ?? result.uniqueId ?? '',
      displayName: result.account?.name ?? '',
      email: result.account?.username ?? '',
      roles: ((result.idTokenClaims as Record<string, unknown>)?.roles as AppRole[]) ?? [],
    };
  }
}
