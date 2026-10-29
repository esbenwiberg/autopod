import { ClientSecretCredential, type ClientSecretCredentialOptions } from '@azure/identity';

export const IDENTITY_FIXTURE_TENANT = '11111111-1111-4111-8111-111111111111';
export const IDENTITY_FIXTURE_SCOPE = 'https://management.azure.com/.default';
/** Real Azure Identity/MSAL stack, with ALL HTTP handled in memory; never actual credentials/Azure. */
export function createIdentityCompatibilityFixture() {
  const requests: { method: string; url: string; body: string }[] = [];
  const authority = `https://login.microsoftonline.com/${IDENTITY_FIXTURE_TENANT}`;
  const httpClient: NonNullable<ClientSecretCredentialOptions['httpClient']> = {
    async sendRequest(request) {
      if (new URL(request.url).hostname !== 'login.microsoftonline.com')
        throw new Error('Unexpected auth origin; no network is permitted');
      requests.push({
        method: request.method,
        url: request.url,
        body: typeof request.body === 'string' ? request.body : '',
      });
      let body: unknown;
      if (request.url.includes('discovery/instance'))
        body = {
          tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
          metadata: [
            {
              preferred_network: 'login.microsoftonline.com',
              preferred_cache: 'login.windows.net',
              aliases: ['login.microsoftonline.com', 'login.windows.net'],
            },
          ],
        };
      else if (request.url.includes('.well-known/openid-configuration'))
        body = {
          issuer: `${authority}/v2.0`,
          authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
          token_endpoint: `${authority}/oauth2/v2.0/token`,
          jwks_uri: `${authority}/discovery/v2.0/keys`,
          end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
        };
      else if (
        request.method === 'POST' &&
        new URL(request.url).origin + new URL(request.url).pathname ===
          `${authority}/oauth2/v2.0/token`
      )
        body = {
          token_type: 'Bearer',
          expires_in: 3600,
          ext_expires_in: 3600,
          access_token: 'fixture-access-token',
        };
      else throw new Error(`Unrecognized fixture auth request ${request.method} ${request.url}`);
      request.headers.set('content-type', 'application/json');
      return { request, status: 200, headers: request.headers, bodyAsText: JSON.stringify(body) };
    },
  };
  const credential = new ClientSecretCredential(
    IDENTITY_FIXTURE_TENANT,
    '22222222-2222-4222-8222-222222222222',
    'fixture-client-secret',
    { httpClient, disableInstanceDiscovery: true },
  );
  return { credential, requests };
}
