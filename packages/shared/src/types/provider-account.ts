import type { ModelProvider, ProviderCredentials } from './model-provider.js';
import type { RuntimeType } from './runtime.js';

export type ProviderAccountProvider = ProviderCredentials['provider'];

export interface ProviderFailoverTarget {
  providerAccountId: string;
  runtime: RuntimeType;
  model: string;
}

export interface ProviderFailoverPolicy {
  targets: ProviderFailoverTarget[];
  maxHops?: number;
}

export interface ProviderAccount {
  id: string;
  name: string;
  provider: ProviderAccountProvider;
  credentials: ProviderCredentials | null;
  failoverPolicy: ProviderFailoverPolicy | null;
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
