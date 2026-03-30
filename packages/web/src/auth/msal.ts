import {
  type AccountInfo,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from '@azure/msal-browser';

let _instance: PublicClientApplication | null = null;
let _clientId: string | null = null;

/** Initialise the MSAL instance. Call once after fetching /config from the daemon. */
export async function initMsal(clientId: string, tenantId: string): Promise<void> {
  _clientId = clientId;
  _instance = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: {
      cacheLocation: 'localStorage',
      storeAuthStateInCookie: false,
    },
  });
  await _instance.initialize();
}

function getInstance(): PublicClientApplication {
  if (!_instance) throw new Error('MSAL not initialised — call initMsal() first');
  return _instance;
}

/**
 * Handle the redirect response after loginRedirect().
 * Must be called once on page load.
 * Returns the account if a redirect just completed, otherwise null.
 */
export async function handleRedirect(): Promise<AccountInfo | null> {
  const instance = getInstance();
  const result = await instance.handleRedirectPromise();
  if (result) return result.account;
  // Pick up any previously signed-in account
  const accounts = instance.getAllAccounts();
  return accounts[0] ?? null;
}

/**
 * Acquire a token silently, falling back to redirect if interaction is required.
 * The returned token is a Bearer token accepted by the autopod daemon.
 */
export async function acquireToken(): Promise<string> {
  const instance = getInstance();
  const accounts = instance.getAllAccounts();
  if (accounts.length === 0) {
    // No account — start login redirect
    await instance.loginRedirect({
      scopes: [`api://${_clientId}/.default`],
    });
    // loginRedirect() navigates away — the following line is never reached
    throw new Error('Redirecting to login...');
  }

  try {
    const result = await instance.acquireTokenSilent({
      scopes: [`api://${_clientId}/.default`],
      account: accounts[0],
    });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await instance.acquireTokenRedirect({
        scopes: [`api://${_clientId}/.default`],
        account: accounts[0],
      });
      throw new Error('Redirecting to login...');
    }
    throw err;
  }
}

/** Sign out the current user. */
export async function signOut(): Promise<void> {
  const instance = getInstance();
  const accounts = instance.getAllAccounts();
  if (accounts.length > 0) {
    await instance.logoutRedirect({ account: accounts[0] });
  }
}

/** True if MSAL has been initialised and a user is signed in. */
export function isSignedIn(): boolean {
  return (_instance?.getAllAccounts().length ?? 0) > 0;
}
