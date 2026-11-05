import { type EffectiveLaunchConfig, launchWorkSchema } from '@autopod/shared';

/** Source selectors are remote branch names; reference snapshots have separate semantics. */
export function validateLaunchSources(
  work: { startBranch?: string; baseBranch?: string } | undefined,
): void {
  for (const field of ['startBranch', 'baseBranch'] as const) {
    const value = work?.[field];
    if (value === undefined) continue;
    if (
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ||
      !launchWorkSchema.shape[field].safeParse(value).success
    )
      throw new Error(
        `work.${field} ${JSON.stringify(value)} requires a published remote branch name, not a commit ID or Git revision expression. Keep the researched SHA separately as baseline evidence; use a separately supported control-plane path for exact-revision requirements.`,
      );
  }
}

export function validateEffectiveLaunchSources(config: EffectiveLaunchConfig): void {
  validateLaunchSources(config.work);
  // The repository setup supplies the fallback for both source selectors.
  if (!config.work?.baseBranch && config.repository)
    validateLaunchSources({ baseBranch: config.repository.setup.defaultBranch });
}
