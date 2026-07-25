import type { ProviderAccount, PublicProviderAccount } from '@autopod/shared';

export function redactProviderAccountSecrets(account: ProviderAccount): PublicProviderAccount {
  const publicCredentials =
    account.credentials?.provider === 'api-key'
      ? { provider: account.credentials.provider, providerId: account.credentials.providerId }
      : account.credentials
        ? { provider: account.credentials.provider }
        : null;
  return {
    ...account,
    credentials: publicCredentials,
    hasCredentials: account.credentials !== null,
  };
}
