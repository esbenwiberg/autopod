/**
 * Result of building provider-specific environment for a pod.
 */
export interface ProviderEnvResult {
  /** Environment variables to pass to the agent exec (merged with POD_ID). */
  env: Record<string, string>;
  /** Files to write into the container before exec (e.g., OAuth credentials file). */
  containerFiles: Array<{ path: string; content: string }>;
  /** If true, caller must read back credentials after exec completes (token rotation). */
  requiresPostExecPersistence: boolean;
}
