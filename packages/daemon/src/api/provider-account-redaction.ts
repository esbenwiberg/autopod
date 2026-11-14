import type {
  ProviderAccount,
  ProviderAccountHealth,
  PublicProviderAccount,
} from '@autopod/shared';

export function redactProviderAccountSecrets(
  account: ProviderAccount,
  health?: { current(accountId: string): ProviderAccountHealth },
): PublicProviderAccount {
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
    ...(health ? { health: health.current(account.id) } : {}),
  };
}
