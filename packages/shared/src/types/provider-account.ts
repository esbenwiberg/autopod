import type { ModelProvider, ProviderCredentials } from './model-provider.js';
import type { RuntimeType } from './runtime.js';

/** Stable provider identity from the compiled catalog (legacy or generic). */
export type ProviderAccountProvider = string;

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

export type PublicProviderCredentials =
  | Pick<Exclude<ProviderCredentials, { provider: 'api-key' }>, 'provider'>
  | Pick<Extract<ProviderCredentials, { provider: 'api-key' }>, 'provider' | 'providerId'>;

export type PublicProviderAccount = Omit<ProviderAccount, 'credentials'> & {
  credentials: PublicProviderCredentials | null;
  hasCredentials: boolean;
};

export type ProviderAuthSource =
  | {
      type: 'provider-account';
      provider: ProviderAccountProvider;
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
