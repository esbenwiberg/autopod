/**
 * Result of building provider-specific environment for a pod.
 */
export interface ProviderEnvResult {
  /** Non-secret environment variables to pass to the agent exec. */
  env: Record<string, string>;
  /** Files to write into the container before exec (e.g., OAuth credentials file). */
  containerFiles: Array<{ path: string; content: string }>;
  /**
   * Secret files that hold sensitive values (tokens, API keys). Written to the
   * container at the specified path with mode 0o400 (owner-read-only). The
   * corresponding `env` entries use the `*_FILE` convention to point at the path
   * so secrets never appear in `docker inspect` output or process env dumps.
   */
  secretFiles: Array<{ path: string; content: string }>;
  /** If true, caller must read back credentials after exec completes (token rotation). */
  requiresPostExecPersistence: boolean;
}
