import type { PimSelection } from './launch-config.js';

export interface PimAccountIdentity {
  tenantId: string;
  principalId: string;
}
export interface PimEligibility
  extends Pick<
    PimSelection,
    'type' | 'tenantId' | 'principalId' | 'eligibilityId' | 'roleId' | 'scope' | 'displayName'
  > {
  scopeName: string;
  startsAt: string;
  expiresAt: string | null;
  /** Null means provider policy could not be read, not unlimited duration. */
  maximumDurationMinutes: number | null;
  policyUnavailableReason?: string;
  provider: {
    scheduleId: string;
    roleDefinitionId: string;
    directoryScopeId?: string | null;
    appScopeId?: string | null;
  };
}
export type PimDiscoveryFamily =
  | { type: PimSelection['type']; available: true; assignments: PimEligibility[] }
  | { type: PimSelection['type']; available: false; assignments: []; reason: string };
export interface PimDiscovery {
  account: PimAccountIdentity;
  discoveredAt: string;
  families: PimDiscoveryFamily[];
}
export type PimActivationStatus =
  | 'reserved'
  | 'submitting'
  | 'pending'
  | 'active'
  | 'failed'
  | 'uncertain'
  | 'expired'
  | 'released';
export interface PimActivation {
  id: string;
  assignmentKey: string;
  status: PimActivationStatus;
  providerRequestId: string | null;
  providerAssignmentId: string | null;
  ownership: 'autopod' | 'pre-existing' | 'unconfirmed';
  expiresAt: string | null;
  reason: string | null;
}
