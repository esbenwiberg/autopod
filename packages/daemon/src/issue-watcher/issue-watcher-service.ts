import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CreatePodRequest,
  type Pod,
  type Profile,
  type SystemEvent,
  type WatchedIssue,
  collectPiiPatternNames,
  parseBriefs,
  processContent,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { EventBus } from '../pods/event-bus.js';
import type { PodManager } from '../pods/pod-manager.js';
import type { ProfileStore } from '../profiles/profile-store.js';
import type { SafetyEventsRepository } from '../safety/safety-events-repository.js';
import type { IssueClient, WatchedIssueCandidate } from './issue-client.js';
import { createIssueClient } from './issue-client.js';
import type { IssueWatcherRepository } from './issue-watcher-repository.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const ISSUE_WATCHER_USER_ID = 'issue-watcher';

export interface IssueWatcherService {
  start(): void;
  stop(): void;
}

export interface IssueWatcherServiceDependencies {
  profileStore: ProfileStore;
  podManager: PodManager;
  eventBus: EventBus;
  issueWatcherRepo: IssueWatcherRepository;
  safetyEventsRepo?: SafetyEventsRepository;
  logger: Logger;
  pollIntervalMs?: number;
  /** Override for testing — inject a mock client factory */
  issueClientFactory?: (profile: Profile) => IssueClient;
}

export function createIssueWatcherService(
  deps: IssueWatcherServiceDependencies,
): IssueWatcherService {
  const {
    profileStore,
    podManager,
    eventBus,
    issueWatcherRepo,
    safetyEventsRepo,
    logger: parentLogger,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    issueClientFactory = createIssueClient,
  } = deps;

  const logger = parentLogger.child({ component: 'issue-watcher' });

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let unsubscribe: (() => void) | null = null;

  function resolveTargetProfile(
    triggerLabel: string,
    labelPrefix: string,
    currentProfile: Profile,
  ): { profileName: string; output: 'artifact' | 'planner' } | null {
    // Bare label → use current profile
    if (triggerLabel === labelPrefix) {
      return { profileName: currentProfile.name, output: 'planner' };
    }

    // Prefixed label → extract suffix
    const suffix = triggerLabel.slice(labelPrefix.length + 1);
    if (!suffix) return { profileName: currentProfile.name, output: 'planner' };

    // Historical advertised route: `autopod:artifact` means this profile in
    // artifact output mode, not a profile literally named "artifact".
    if (suffix === 'artifact') {
      return { profileName: currentProfile.name, output: 'artifact' };
    }

    // Route to named profile
    if (!profileStore.exists(suffix)) {
      logger.warn(
        { label: triggerLabel, profile: suffix },
        'Label references non-existent profile, skipping',
      );
      return null;
    }

    // Verify the target profile shares the same repo
    try {
      const targetProfile = profileStore.get(suffix);
      if (targetProfile.repoUrl !== currentProfile.repoUrl) {
        logger.warn(
          {
            label: triggerLabel,
            source: currentProfile.name,
            target: suffix,
          },
          'Cross-repo label routing not allowed, skipping',
        );
        return null;
      }
    } catch {
      return null;
    }

    return { profileName: suffix, output: 'planner' };
  }

  function issueSpecSlug(issueId: string): string {
    const safeId = issueId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return `issue-${safeId || 'work-item'}`;
  }

  function buildPlannerTask(input: {
    issueId: string;
    issueUrl: string;
    title: string;
    body: string;
    requirements: string[];
    specSlug: string;
  }): string {
    const requirementsSection =
      input.requirements.length > 0
        ? `\n\n## Requirements From Work Item\n${input.requirements.map((r) => `- ${r}`).join('\n')}`
        : '';

    return `You are the planning pod for this issue. Do not implement the product change.

Use the injected \`/prep\` skill to create a single-pod implementation spec. The \`/prep\` skill is available in this planner pod through injected skills.

Important interaction rule: when \`/prep\` would normally ask the human a question, use the \`ask_ai\` skill/tool first and continue from that answer. Only use \`ask_human\` if \`ask_ai\` cannot resolve the question confidently or the answer requires a real product-owner decision.

Write exactly this spec folder:

\`specs/${input.specSlug}/\`

It must contain \`brief.md\` and \`contract.yaml\` compatible with \`ap pod create --spec\`. Use contract scenarios, required facts, and human-review items where appropriate. Commit only the spec files and any directly required planning context.

## Source Issue

ID: ${input.issueId}
URL: ${input.issueUrl}
Title: ${input.title}

## Body

${input.body}${requirementsSection}
`;
  }

  function buildDirectIssueTask(input: {
    issueId: string;
    issueUrl: string;
    title: string;
    body: string;
    requirements: string[];
  }): string {
    const requirementsSection =
      input.requirements.length > 0
        ? `\n\n## Requirements From Work Item\n${input.requirements.map((r) => `- ${r}`).join('\n')}`
        : '';

    return `Implement this issue.

## Source Issue

ID: ${input.issueId}
URL: ${input.issueUrl}
Title: ${input.title}

## Body

${input.body}${requirementsSection}
`;
  }

  function readPlannerBrief(plannerPod: Pod, issueId: string) {
    if (!plannerPod.worktreePath) {
      throw new Error(`Planner pod ${plannerPod.id} has no worktree path`);
    }
    const specSlug = issueSpecSlug(issueId);
    const specRoot = path.join(plannerPod.worktreePath, 'specs', specSlug);
    const briefPath = path.join(specRoot, 'brief.md');
    const contractPath = path.join(specRoot, 'contract.yaml');
    if (!existsSync(briefPath)) {
      throw new Error(
        `Planner pod did not write ${path.relative(plannerPod.worktreePath, briefPath)}`,
      );
    }
    if (!existsSync(contractPath)) {
      throw new Error(
        `Planner pod did not write ${path.relative(plannerPod.worktreePath, contractPath)}`,
      );
    }

    const [brief] = parseBriefs(
      [
        {
          filename: specSlug,
          content: readFileSync(briefPath, 'utf8'),
          contractContent: readFileSync(contractPath, 'utf8'),
        },
      ],
      (contextPath) => readFileSync(path.join(specRoot, contextPath), 'utf8'),
    );
    if (!brief?.contract) {
      throw new Error(`Planner pod wrote an invalid contract spec at specs/${specSlug}`);
    }
    return { brief, specSlug };
  }

  async function markIssueFailed(input: {
    client: IssueClient;
    prefix: string;
    tracked: WatchedIssue;
    podId: string;
    comment: string;
  }): Promise<void> {
    issueWatcherRepo.updateStatus(input.tracked.id, 'failed');
    try {
      await input.client.removeLabel(input.tracked.issueId, `${input.prefix}:in-progress`);
      await input.client.addLabel(input.tracked.issueId, `${input.prefix}:failed`);
      await input.client.addComment(input.tracked.issueId, input.comment);
    } catch (err) {
      logger.warn(
        { err, podId: input.podId, issueId: input.tracked.issueId },
        'Failed to update failed issue labels/comment',
      );
    }

    eventBus.emit({
      type: 'issue_watcher.completed',
      timestamp: new Date().toISOString(),
      profileName: input.tracked.profileName,
      issueUrl: input.tracked.issueUrl,
      podId: input.podId,
      outcome: 'failed',
    });
  }

  async function processCandidate(
    candidate: WatchedIssueCandidate,
    profile: Profile,
    client: IssueClient,
  ): Promise<void> {
    const provider = profile.prProvider === 'ado' ? 'ado' : 'github';

    // Resolve which profile should handle this issue
    const target = resolveTargetProfile(
      candidate.triggerLabel,
      profile.issueWatcherLabelPrefix ?? 'autopod',
      profile,
    );
    if (!target) {
      // Post error comment
      try {
        await client.addComment(
          candidate.id,
          `Could not resolve profile for label \`${candidate.triggerLabel}\`. Skipping.`,
        );
      } catch {
        // best-effort
      }
      return;
    }

    // Check for duplicates
    if (issueWatcherRepo.exists(provider, candidate.id, target.profileName)) {
      return;
    }

    // Issue title/body/requirements come from anyone who can file or comment on an issue —
    // treat as untrusted. Quarantine wraps prompt-injection patterns in markers
    // the agent can recognize; PII sanitization strips secrets before storage.
    const sanitizeUntrusted = (text: string) =>
      processContent(text, {
        sanitization: { preset: 'standard' },
        quarantine: { enabled: true },
      });

    const titleResult = sanitizeUntrusted(candidate.title);
    const bodyResult = sanitizeUntrusted(candidate.body);
    const requirementResults = candidate.requirements?.map(sanitizeUntrusted);

    const allThreats = [
      ...titleResult.threats,
      ...bodyResult.threats,
      ...(requirementResults?.flatMap((r) => r.threats) ?? []),
    ];
    if (allThreats.length > 0) {
      logger.warn(
        {
          issueId: candidate.id,
          issueUrl: candidate.url,
          quarantined:
            titleResult.quarantined ||
            bodyResult.quarantined ||
            (requirementResults?.some((r) => r.quarantined) ?? false),
          threatPatterns: [...new Set(allThreats.map((t) => t.pattern))],
          threatCount: allThreats.length,
        },
        'Prompt-injection or PII patterns detected in issue content',
      );
    }

    // Write safety_events rows for all detections. Insert BEFORE createSession so
    // we have row ids to backfill with attachPodId once the pod id is known.
    const safetyRowIds: number[] = [];
    if (safetyEventsRepo) {
      const sanitizedAll = [
        titleResult.text,
        bodyResult.text,
        ...(requirementResults?.map((r) => r.text) ?? []),
      ].join('\n');
      const payloadExcerpt = sanitizedAll.slice(0, 256);

      for (const threat of allThreats) {
        safetyRowIds.push(
          safetyEventsRepo.insert({
            podId: null,
            source: 'issue_body',
            kind: 'injection',
            patternName: threat.pattern,
            severity: threat.severity,
            payloadExcerpt,
          }),
        );
      }

      const originalAll = [candidate.title, candidate.body, ...(candidate.requirements ?? [])].join(
        '\n',
      );
      for (const patternName of collectPiiPatternNames(originalAll)) {
        safetyRowIds.push(
          safetyEventsRepo.insert({
            podId: null,
            source: 'issue_body',
            kind: 'pii',
            patternName,
            severity: null,
            payloadExcerpt,
          }),
        );
      }
    }

    const specSlug = issueSpecSlug(candidate.id);
    const seriesId = `issue-${provider}-${candidate.id}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const seriesName = `Issue ${candidate.id}: ${titleResult.text}`.slice(0, 120);
    const requirements = requirementResults?.map((r) => r.text) ?? [];
    const request: CreatePodRequest =
      target.output === 'artifact'
        ? {
            profileName: target.profileName,
            task: buildDirectIssueTask({
              issueId: candidate.id,
              issueUrl: candidate.url,
              title: titleResult.text,
              body: bodyResult.text,
              requirements,
            }),
            branchPrefix: `issue-${candidate.id}/`,
            skipValidation: true,
            options: { agentMode: 'auto', output: 'artifact', validate: false },
            seriesId,
            seriesName,
            seriesDescription: `Implement issue ${candidate.id}: ${titleResult.text}`,
            briefTitle: `Issue ${candidate.id}`,
          }
        : {
            profileName: target.profileName,
            task: buildPlannerTask({
              issueId: candidate.id,
              issueUrl: candidate.url,
              title: titleResult.text,
              body: bodyResult.text,
              requirements,
              specSlug,
            }),
            branchPrefix: `issue-${candidate.id}/`,
            skipValidation: true,
            options: { agentMode: 'auto', output: 'branch', validate: false },
            seriesId,
            seriesName,
            seriesDescription: `Plan and implement issue ${candidate.id}: ${titleResult.text}`,
            briefTitle: `Plan issue ${candidate.id}`,
            prMode: 'single',
            autoApprove: true,
          };

    let pod: Pod;
    try {
      pod = podManager.createSession(request, ISSUE_WATCHER_USER_ID);
    } catch (err) {
      logger.error(
        { err, issueId: candidate.id, profile: target.profileName },
        'Failed to create pod from issue',
      );
      try {
        await client.addComment(
          candidate.id,
          `Failed to create autopod pod: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // best-effort
      }
      return;
    }

    // Backfill pod_id on safety rows now that the pod exists.
    // If createSession threw above, rows remain pod_id=NULL (aggregated under __pre_creation__).
    if (safetyRowIds.length > 0 && safetyEventsRepo) {
      safetyEventsRepo.attachPodId(safetyRowIds, pod.id);
    }

    // Track the issue
    issueWatcherRepo.create({
      profileName: target.profileName,
      provider,
      issueId: candidate.id,
      issueUrl: candidate.url,
      issueTitle: candidate.title,
      status: 'in_progress',
      podId: pod.id,
      phase: target.output === 'artifact' ? 'working' : 'planning',
      triggerLabel: candidate.triggerLabel,
    });

    // Swap labels: remove trigger, add in-progress
    const prefix = profile.issueWatcherLabelPrefix;
    try {
      await client.removeLabel(candidate.id, candidate.triggerLabel);
      await client.addLabel(candidate.id, `${prefix}:in-progress`);
    } catch (err) {
      logger.warn({ err, issueId: candidate.id }, 'Failed to swap labels on issue');
    }

    // Post status comment
    try {
      await client.addComment(
        candidate.id,
        target.output === 'artifact'
          ? `autopod artifact pod \`${pod.id}\` started for this issue.`
          : `autopod planner pod \`${pod.id}\` started for this issue. It will write a /prep spec, then start the implementation pod.`,
      );
    } catch (err) {
      logger.warn({ err, issueId: candidate.id }, 'Failed to post status comment on issue');
    }

    // Emit event
    eventBus.emit({
      type: 'issue_watcher.picked_up',
      timestamp: new Date().toISOString(),
      profileName: target.profileName,
      issueUrl: candidate.url,
      issueTitle: candidate.title,
      podId: pod.id,
    });

    logger.info(
      {
        issueId: candidate.id,
        podId: pod.id,
        profile: target.profileName,
        output: target.output,
      },
      'Issue picked up and pod created',
    );
  }

  async function pollProfile(profile: Profile): Promise<void> {
    // Validate PAT is available
    const hasPat = profile.prProvider === 'ado' ? !!profile.adoPat : !!profile.githubPat;
    if (!hasPat) {
      logger.warn(
        {
          profile: profile.name,
          extends: profile.extends ?? undefined,
          prProvider: profile.prProvider,
        },
        profile.extends
          ? `Issue watcher enabled but no PAT found in inheritance chain (${profile.name} → ${profile.extends}), skipping`
          : 'Issue watcher enabled but no PAT configured, skipping',
      );
      return;
    }

    let client: IssueClient;
    try {
      client = issueClientFactory(profile);
    } catch (err) {
      logger.error({ err, profile: profile.name }, 'Failed to create issue client');
      return;
    }

    let candidates: WatchedIssueCandidate[];
    try {
      candidates = await client.listByLabel(profile.issueWatcherLabelPrefix ?? 'autopod');
    } catch (err) {
      logger.error({ err, profile: profile.name }, 'Failed to list issues by label');
      eventBus.emit({
        type: 'issue_watcher.error',
        timestamp: new Date().toISOString(),
        profileName: profile.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const candidate of candidates) {
      try {
        await processCandidate(candidate, profile, client);
      } catch (err) {
        logger.error(
          { err, issueId: candidate.id, profile: profile.name },
          'Error processing issue candidate',
        );
      }
    }
  }

  async function pollAllProfiles(): Promise<void> {
    if (polling) return; // Prevent overlapping polls
    polling = true;

    try {
      const profiles = profileStore.list().filter((p) => p.issueWatcherEnabled);

      if (profiles.length === 0) return;

      logger.debug({ count: profiles.length }, 'Polling profiles for issues');

      for (const profile of profiles) {
        await pollProfile(profile);
      }
    } catch (err) {
      logger.error({ err }, 'Unexpected error in issue watcher poll');
    } finally {
      polling = false;
    }
  }

  function handleSessionEvent(event: SystemEvent): void {
    if (event.type !== 'pod.status_changed') return;

    const { podId, newStatus } = event;
    if (newStatus !== 'complete' && newStatus !== 'failed' && newStatus !== 'killed') {
      return;
    }

    const tracked = issueWatcherRepo.findBySessionId(podId);
    if (!tracked) return;

    // Fire-and-forget label + comment updates
    void (async () => {
      try {
        const profile = profileStore.get(tracked.profileName);
        const client = issueClientFactory(profile);
        const prefix = profile.issueWatcherLabelPrefix;

        if (newStatus === 'complete' && tracked.phase === 'planning') {
          let plannerPod: Pod;
          let specSlug: string;
          let worker: Pod;
          try {
            plannerPod = podManager.getSession(podId);
            const planned = readPlannerBrief(plannerPod, tracked.issueId);
            specSlug = planned.specSlug;
            const { brief } = planned;
            worker = podManager.createSession(
              {
                profileName: tracked.profileName,
                task: brief.task,
                contract: brief.contract,
                branch: plannerPod.branch,
                baseBranch: plannerPod.baseBranch ?? undefined,
                branchPrefix: `issue-${tracked.issueId}/`,
                seriesId: plannerPod.seriesId,
                seriesName: plannerPod.seriesName,
                seriesDescription: plannerPod.seriesDescription,
                seriesDesign: plannerPod.seriesDesign,
                briefTitle: brief.title,
                touches: brief.touches,
                doesNotTouch: brief.doesNotTouch,
                requireSidecars: brief.requireSidecars,
                prMode: 'single',
                options: { agentMode: 'auto', output: 'pr', validate: true },
              },
              ISSUE_WATCHER_USER_ID,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              { err, issueId: tracked.issueId, plannerPodId: podId },
              'Issue watcher planner handoff failed',
            );
            await markIssueFailed({
              client,
              prefix,
              tracked,
              podId,
              comment: `autopod planner pod \`${podId}\` completed, but implementation handoff failed: ${message}`,
            });
            return;
          }

          issueWatcherRepo.updatePod(tracked.id, worker.id, 'working');
          await client.addComment(
            tracked.issueId,
            `autopod planner pod \`${podId}\` completed \`specs/${specSlug}\`; implementation pod \`${worker.id}\` started and will open the final PR.`,
          );
          logger.info(
            { issueId: tracked.issueId, plannerPodId: podId, workerPodId: worker.id },
            'Issue watcher planner completed; worker pod created',
          );
          return;
        }

        if (newStatus === 'complete') {
          await client.removeLabel(tracked.issueId, `${prefix}:in-progress`);
          await client.addLabel(tracked.issueId, `${prefix}:done`);
          await client.addComment(
            tracked.issueId,
            `autopod implementation pod \`${podId}\` completed successfully.`,
          );
          issueWatcherRepo.updateStatus(tracked.id, 'done');
        } else {
          await client.removeLabel(tracked.issueId, `${prefix}:in-progress`);
          await client.addLabel(tracked.issueId, `${prefix}:failed`);
          await client.addComment(tracked.issueId, `autopod pod \`${podId}\` ${newStatus}.`);
          issueWatcherRepo.updateStatus(tracked.id, 'failed');
        }

        eventBus.emit({
          type: 'issue_watcher.completed',
          timestamp: new Date().toISOString(),
          profileName: tracked.profileName,
          issueUrl: tracked.issueUrl,
          podId,
          outcome: newStatus === 'complete' ? 'done' : 'failed',
        });
      } catch (err) {
        logger.error(
          { err, podId, issueId: tracked.issueId },
          'Failed to update issue on pod completion',
        );
      }
    })();
  }

  function handleEscalationEvent(event: SystemEvent): void {
    if (event.type !== 'pod.escalation_created') return;
    if (event.escalation.type !== 'ask_human') return;

    const tracked = issueWatcherRepo.findBySessionId(event.podId);
    if (!tracked) return;

    void (async () => {
      try {
        const profile = profileStore.get(tracked.profileName);
        const client = issueClientFactory(profile);
        const payload = event.escalation.payload as { question?: string };
        const question = payload.question ?? 'Pod needs human input.';
        await client.addComment(tracked.issueId, `**Pod needs input:**\n\n${question}`);
      } catch (err) {
        logger.error({ err, podId: event.podId }, 'Failed to post escalation comment on issue');
      }
    })();
  }

  return {
    start() {
      // Subscribe to pod events for completion tracking
      unsubscribe = eventBus.subscribe((event) => {
        handleSessionEvent(event);
        handleEscalationEvent(event);
      });

      // Run first poll immediately
      void pollAllProfiles();

      // Schedule recurring polls
      pollTimer = setInterval(() => {
        void pollAllProfiles();
      }, pollIntervalMs);
      pollTimer.unref();

      logger.info({ pollIntervalMs }, 'Issue watcher service started');
    },

    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      logger.info('Issue watcher service stopped');
    },
  };
}
