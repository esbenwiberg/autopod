import { bindHostedControllerProfile } from './hosted-controller-profile.js';
// One-shot synthetic test consents to this exact profile only.
export function bindCanaryProfile(
  ...args: [
    Parameters<typeof bindHostedControllerProfile>[1],
    Parameters<typeof bindHostedControllerProfile>[2],
    Parameters<typeof bindHostedControllerProfile>[3],
    Parameters<typeof bindHostedControllerProfile>[4],
  ]
) {
  return bindHostedControllerProfile(
    {
      profileName: 'repofit',
      profileId: 'profile-f3ec3b28e6369a8879e2a1da',
      profileRevision: 2,
      aiId: 'ai-2aa5da9e201c0adf52150c71',
      aiRevision: 8,
      accountId: 'anth-pro',
      model: 'claude-sonnet-5-5',
    },
    ...args,
    true,
  );
}
