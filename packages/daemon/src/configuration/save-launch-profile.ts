import {
  type ConfigurationKind,
  type ConfigurationPayloads,
  type EffectiveLaunchConfig,
  type LaunchProfile,
  launchProfileSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import {
  type ConfigurationStore,
  type ConfigurationWrite,
  configurationError,
} from './configuration-store.js';
import { configurationDigest } from './launch-resolver.js';

export interface SaveLaunchProfileNames {
  profile: string;
  environment?: string;
  ai?: string;
  workflow?: string;
  githubAccess?: string;
  toolPacks?: string[];
}
export interface SaveLaunchProfileProposal {
  digest: string;
  profileId: string;
  writes: ConfigurationWrite[];
  basedOn: EffectiveLaunchConfig['revisions'];
}
/** Reuse unchanged references; changed categories require names and create separate presets. */
export function proposeLaunchProfile(
  config: EffectiveLaunchConfig,
  names: SaveLaunchProfileNames,
  store: ConfigurationStore,
): SaveLaunchProfileProposal {
  if (config.repository) {
    const original = config.repository.config.setups.find(
      (s) => s.id === config.repository?.setup.id,
    );
    if (configurationDigest(original) !== configurationDigest(config.repository.setup))
      configurationError(
        'Save the edited repository setup before saving this combination as a profile',
        'REPOSITORY_SETUP_SAVE_REQUIRED',
      );
  }
  const writes: ConfigurationWrite[] = [];
  const profileId = `profile-${configurationDigest({ name: names.profile, digest: config.digest }).slice(0, 24)}`;
  const profile = store.get(
    'profile',
    config.profileId,
    config.revisions.find((r) => r.id === config.profileId)?.revision,
  ).payload;
  function reference<K extends ConfigurationKind>(
    kind: K,
    payload: ConfigurationPayloads[K],
    selectedId: string | null,
    newName?: string,
  ): string {
    const prior = config.revisions.find((r) => r.id === selectedId && r.kind === kind);
    if (
      prior &&
      configurationDigest(store.get(kind, prior.id, prior.revision).payload) ===
        configurationDigest(payload)
    )
      return prior.id;
    if (!newName?.trim())
      configurationError(`Name the changed ${kind} preset before saving`, 'PRESET_NAME_REQUIRED');
    const id = `${kind}-${configurationDigest({ profileId, payload, name: newName }).slice(0, 24)}`;
    writes.push({ id, kind, name: newName, payload });
    return id;
  }
  function selected(path: string): string | null {
    return config.provenance[path]?.entityId ?? null;
  }
  const accessPayload = { rules: config.githubAccess.map((r) => r.rule) };
  const toolPackIds = config.toolPacks.map((pack, index) => {
    const original = config.revisions
      .filter((r) => r.kind === 'toolPack')
      .find(
        (r) =>
          configurationDigest(store.get('toolPack', r.id, r.revision).payload) ===
          configurationDigest(pack),
      );
    return reference('toolPack', pack, original?.id ?? null, names.toolPacks?.[index]);
  });
  const payload: LaunchProfile = launchProfileSchema.parse({
    environmentId: reference(
      'environment',
      config.environment,
      selected('environment'),
      names.environment,
    ),
    aiId: reference('ai', config.ai, selected('ai'), names.ai),
    workflowId: reference(
      'workflow',
      { ...config.workflow, intent: config.intent },
      selected('workflow'),
      names.workflow,
    ),
    githubAccessId: accessPayload.rules.length
      ? reference('githubAccess', accessPayload, selected('githubAccess'), names.githubAccess)
      : null,
    toolPackIds,
    requiredSidecarIds: config.requiredSidecarIds,
    execution: config.execution,
    pim: config.pim,
    workerProfileId: profile.workerProfileId,
  });
  writes.push({ id: profileId, kind: 'profile', name: names.profile, payload });
  const proposal = { profileId, writes, basedOn: config.revisions };
  return { ...proposal, digest: configurationDigest(proposal) };
}
export function saveLaunchProfile(
  db: Database.Database,
  store: ConfigurationStore,
  proposal: SaveLaunchProfileProposal,
  expectedDigest: string,
) {
  const { digest, ...body } = proposal;
  if (digest !== expectedDigest || digest !== configurationDigest(body))
    configurationError('Save proposal changed', 'CONFIG_CHANGED', 409);
  return db.transaction(() => {
    store.assertCurrent(proposal.basedOn);
    store.writeBatch(proposal.writes);
    return store.get('profile', proposal.profileId);
  })();
}
