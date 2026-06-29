import type { ModelProvider, ProviderCredentials } from './model-provider.js';

export type ProviderAccountProvider = ProviderCredentials['provider'];

export interface ProviderAccount {
  id: string;
  name: string;
  provider: ProviderAccountProvider;
  credentials: ProviderCredentials | null;
  createdAt: string;
  updatedAt: string;
  lastAuthenticatedAt: string | null;
  lastUsedAt: string | null;
}

export type PublicProviderAccount = Omit<ProviderAccount, 'credentials'> & {
  credentials: Pick<ProviderCredentials, 'provider'> | null;
  hasCredentials: boolean;
};

export type ProviderAuthSource =
  | {
      type: 'provider-account';
      provider: ModelProvider;
      account: PublicProviderAccount;
      inherited: boolean;
    }
  | {
      type: 'legacy-profile';
      provider: ModelProvider;
      profileName: string;
    }
  | {
      type: 'env-fallback';
      provider: ModelProvider;
    }
  | {
      type: 'none';
      provider: ModelProvider | null;
    };
