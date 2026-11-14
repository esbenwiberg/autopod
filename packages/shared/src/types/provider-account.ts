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

/**
 * Passively observed account health. Unhealthy states come only from definitive provider
 * refusals and apply to the credentials that were refused; a credential write makes them
 * `unknown` again. `ok` records a later success or an operator override.
 */
export type ProviderAccountHealthState = 'ok' | 'auth_revoked' | 'out_of_credits' | 'unknown';

export type ProviderAccountHealthSource =
  | 'observed_failure'
  | 'observed_success'
  | 'operator_override';

export interface ProviderAccountHealth {
  state: ProviderAccountHealthState;
  observedAt: string | null;
  source: ProviderAccountHealthSource | null;
  /** Sanitized provider message or operator reason. */
  reason: string | null;
  /** Operator who recorded an override. */
  actor: string | null;
}

export type PublicProviderAccount = Omit<ProviderAccount, 'credentials'> & {
  credentials: PublicProviderCredentials | null;
  hasCredentials: boolean;
  /** Absent from daemons that predate account health. */
  health?: ProviderAccountHealth;
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
