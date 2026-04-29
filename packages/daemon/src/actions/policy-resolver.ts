import type { ActionPolicy, Profile } from '@autopod/shared';

/**
 * Resolve the effective action policy for a profile.
 *
 * Auto-injects the `deploy` group into `enabledGroups` whenever
 * `profile.deployment.enabled === true`. The deploy handler itself gates
 * execution on the same flag (`deploy-handler.ts` checks `deployment.enabled`),
 * so making the toggle implicit removes a footgun where users enabled
 * deployment but forgot to also tick the `deploy` action group — leaving the
 * `run_deploy_script` tool invisible to the agent.
 *
 * If the profile has no action policy at all but deployment is enabled, a
 * minimal policy is synthesized so the deploy action still surfaces.
 */
export function resolveEffectiveActionPolicy(profile: Profile): ActionPolicy | null {
  const deployEnabled = profile.deployment?.enabled === true;

  if (!profile.actionPolicy) {
    if (!deployEnabled) return null;
    return {
      enabledGroups: ['deploy'],
      sanitization: { preset: 'standard' },
    };
  }

  if (!deployEnabled) return profile.actionPolicy;
  if (profile.actionPolicy.enabledGroups.includes('deploy')) return profile.actionPolicy;

  return {
    ...profile.actionPolicy,
    enabledGroups: [...profile.actionPolicy.enabledGroups, 'deploy'],
  };
}
