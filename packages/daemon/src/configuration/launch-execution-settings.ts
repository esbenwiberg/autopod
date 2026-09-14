import {
  type EffectiveLaunchConfig,
  type RepositorySetup,
  type ValidationPhase,
  outputModeFromPodOptions,
} from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { configurationError } from './configuration-store.js';
import { launchPodOptions } from './launch-pod-options.js';

/** Build engine inputs exclusively from an admitted launch; storage/inheritance metadata is not an execution input. */
export function resolveLaunchExecutionSettings(
  config: EffectiveLaunchConfig,
  binding: { image: string },
): PodExecutionSettings {
  const setup = config.repository?.setup;
  const flow = config.workflow;
  const main = config.ai.main;
  const account = config.agentAccounts[main.providerAccountId];
  if (!account) configurationError('Launch account identity is missing', 'SNAPSHOT_CORRUPT', 500);
  function literals(values: RepositorySetup['buildEnv']): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).flatMap(([name, value]) =>
        'value' in value ? [[name, value.value]] : [],
      ),
    );
  }
  const options = launchPodOptions(config);
  const phases: ValidationPhase[] = [
    'setup',
    'lint',
    'sast',
    'build',
    'test',
    'health',
    'pages',
    'facts',
    'review',
    'advisory',
  ];
  const skills = new Map<string, PodExecutionSettings['skills'][number]>();
  const mcps = new Map<string, PodExecutionSettings['mcpServers'][number]>();
  for (const pack of config.toolPacks) {
    for (const skill of pack.skills) {
      const pinned = config.toolContents[`skill:${skill.name}`];
      if (!pinned) configurationError('Pinned skill content is missing', 'SNAPSHOT_CORRUPT', 500);
      skills.set(skill.name, {
        name: skill.name,
        description: skill.description,
        source: { type: 'inline', content: pinned.content },
      });
    }
    for (const mcp of pack.mcpServers) {
      const transport = mcp.transport;
      mcps.set(
        mcp.name,
        transport.type === 'stdio'
          ? {
              name: mcp.name,
              type: 'stdio',
              command: transport.command,
              args: transport.args,
              env: literals(transport.env),
            }
          : {
              name: mcp.name,
              type: 'http',
              url: transport.url,
              headers: literals(transport.headers),
            },
      );
    }
  }
  return {
    name: config.profileId,
    repoUrl: config.repository?.config.remote ?? null,
    defaultBranch: setup?.defaultBranch ?? null,
    template: config.environment.template,
    buildCommand: setup?.buildCommand ?? null,
    startCommand: setup?.startCommand ?? null,
    buildWorkDir: setup?.buildWorkDir ?? null,
    healthPath: setup?.healthPath ?? null,
    healthTimeout: setup?.healthTimeout ?? null,
    smokePages: setup?.smokePages ?? [],
    maxValidationAttempts: flow.maxValidationAttempts,
    defaultModel: main.model,
    reviewerModel:
      config.ai.reviewer.mode === 'independent' ? config.ai.reviewer.route.model : main.model,
    defaultRuntime: main.runtime,
    reasoningEffort: main.reasoningEffort,
    executionTarget: config.execution.target,
    customInstructions:
      config.toolPacks
        .flatMap((p) => p.instructions.map((i) => `## ${i.heading}\n\n${i.content}`))
        .join('\n\n') || null,
    agentDonePrompt: flow.agentDonePrompt,
    escalation: flow.escalation,
    warmImageTag: binding.image,
    mcpServers: [...mcps.values()],
    claudeMdSections: [],
    skills: [...skills.values()],
    networkPolicy: config.execution.networkPolicy,
    // New broker grants are deliberately not converted to legacy generic HTTP capabilities.
    actionPolicy: null,
    pod: options,
    outputMode: outputModeFromPodOptions(options),
    modelProvider: account.adapter,
    providerAccountId: main.providerAccountId,
    providerFailover: { targets: main.failover, maxHops: main.maxHops },
    providerCredentials: null,
    testCommand: setup?.testCommand ?? null,
    validationSetupCommand: setup?.validationSetupCommand ?? null,
    buildEnv: literals(setup?.buildEnv ?? {}),
    buildTimeout: setup?.buildTimeout ?? null,
    testTimeout: setup?.testTimeout ?? null,
    lintCommand: setup?.lintCommand ?? null,
    lintTimeout: setup?.lintTimeout ?? null,
    sastCommand: setup?.sastCommand ?? null,
    sastTimeout: setup?.sastTimeout ?? null,
    mergePollIntervalSec: flow.mergePollIntervalSec,
    preflightConflictPolicy: flow.preflightConflictPolicy,
    prProvider: setup?.integrations.prProvider ?? null,
    privateRegistries: (setup?.integrations.privateRegistries ?? []).map(
      ({ type, url, scope }) => ({ type, url, scope }),
    ),
    registryPat: null,
    branchPrefix: flow.branchPrefix,
    containerMemoryGb: config.resolvedExecution.main.memoryGb,
    tokenBudget: flow.tokenBudget,
    tokenBudgetWarnAt: flow.tokenBudgetWarnAt,
    tokenBudgetPolicy: flow.tokenBudgetPolicy,
    maxBudgetExtensions: flow.maxBudgetExtensions,
    hasWebUi: setup?.hasWebUi ?? false,
    pimActivations: [],
    sidecars: null,
    trustedSource: !!(setup && config.repository?.config.trustedSetupIds.includes(setup.id)),
    // Retained only in the legacy execution shape for rollback/history readers.
    testPipeline: null,
    securityScan: flow.securityScan,
    deployment: setup?.integrations.deployment
      ? { ...setup.integrations.deployment, env: literals(setup.integrations.deployment.env) }
      : null,
    codeIntelligence: null,
    skipValidationPhases: phases.filter((p) => !flow.validationPhases.includes(p)),
  };
}
