import type { ProviderAccount, PublicProviderAccount } from '@autopod/shared';

export function redactProviderAccountSecrets(account: ProviderAccount): PublicProviderAccount {
  return {
    ...account,
    credentials: account.credentials ? { provider: account.credentials.provider } : null,
    hasCredentials: account.credentials !== null,
  };
}
