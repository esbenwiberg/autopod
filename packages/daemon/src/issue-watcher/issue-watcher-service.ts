import type { CreateSessionRequest, Profile, Session, SystemEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ProfileStore } from '../profiles/profile-store.js';
import type { EventBus } from '../sessions/event-bus.js';
import type { SessionManager } from '../sessions/session-manager.js';
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
  sessionManager: SessionManager;
  eventBus: EventBus;
  issueWatcherRepo: IssueWatcherRepository;
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
    sessionManager,
    eventBus,
    issueWatcherRepo,
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
  ): { profileName: string; outputMode?: 'artifact' } | null {
    // Bare label → use current profile
    if (triggerLabel === labelPrefix) {
      return { profileName: currentProfile.name };
    }

    // Prefixed label → extract suffix
    const suffix = triggerLabel.slice(labelPrefix.length + 1);
    if (!suffix) return { profileName: currentProfile.name };

    // Special case: artifact output mode
    if (suffix === 'artifact') {
      return { profileName: currentProfile.name, outputMode: 'artifact' };
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

    return { profileName: suffix };
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
      profile.issueWatcherLabelPrefix,
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

    // Build session request
    const task = `${candidate.title}\n\n${candidate.body}`;
    const request: CreateSessionRequest = {
      profileName: target.profileName,
      task,
      branchPrefix: `issue-${candidate.id}/`,
      acceptanceCriteria: candidate.acceptanceCriteria,
      outputMode: target.outputMode,
    };

    let session: Session;
    try {
      session = sessionManager.createSession(request, ISSUE_WATCHER_USER_ID);
    } catch (err) {
      logger.error(
        { err, issueId: candidate.id, profile: target.profileName },
        'Failed to create session from issue',
      );
      try {
        await client.addComment(
          candidate.id,
          `Failed to create autopod session: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // best-effort
      }
      return;
    }

    // Track the issue
    issueWatcherRepo.create({
      profileName: target.profileName,
      provider,
      issueId: candidate.id,
      issueUrl: candidate.url,
      issueTitle: candidate.title,
      status: 'in_progress',
      sessionId: session.id,
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
        `autopod session \`${session.id}\` started for this issue.`,
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
      sessionId: session.id,
    });

    logger.info(
      {
        issueId: candidate.id,
        sessionId: session.id,
        profile: target.profileName,
      },
      'Issue picked up and session created',
    );
  }

  async function pollProfile(profile: Profile): Promise<void> {
    // Validate PAT is available
    const hasPat = profile.prProvider === 'ado' ? !!profile.adoPat : !!profile.githubPat;
    if (!hasPat) {
      logger.warn(
        { profile: profile.name, prProvider: profile.prProvider },
        'Issue watcher enabled but no PAT configured, skipping',
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
      candidates = await client.listByLabel(profile.issueWatcherLabelPrefix);
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
    if (event.type !== 'session.status_changed') return;

    const { sessionId, newStatus } = event;
    if (newStatus !== 'complete' && newStatus !== 'failed' && newStatus !== 'killed') {
      return;
    }

    const tracked = issueWatcherRepo.findBySessionId(sessionId);
    if (!tracked) return;

    // Fire-and-forget label + comment updates
    void (async () => {
      try {
        const profile = profileStore.get(tracked.profileName);
        const client = issueClientFactory(profile);
        const prefix = profile.issueWatcherLabelPrefix;

        if (newStatus === 'complete') {
          await client.removeLabel(tracked.issueId, `${prefix}:in-progress`);
          await client.addLabel(tracked.issueId, `${prefix}:done`);
          await client.addComment(
            tracked.issueId,
            `autopod session \`${sessionId}\` completed successfully.`,
          );
          issueWatcherRepo.updateStatus(tracked.id, 'done');
        } else {
          await client.removeLabel(tracked.issueId, `${prefix}:in-progress`);
          await client.addLabel(tracked.issueId, `${prefix}:failed`);
          await client.addComment(
            tracked.issueId,
            `autopod session \`${sessionId}\` ${newStatus}.`,
          );
          issueWatcherRepo.updateStatus(tracked.id, 'failed');
        }

        eventBus.emit({
          type: 'issue_watcher.completed',
          timestamp: new Date().toISOString(),
          profileName: tracked.profileName,
          issueUrl: tracked.issueUrl,
          sessionId,
          outcome: newStatus === 'complete' ? 'done' : 'failed',
        });
      } catch (err) {
        logger.error(
          { err, sessionId, issueId: tracked.issueId },
          'Failed to update issue on session completion',
        );
      }
    })();
  }

  function handleEscalationEvent(event: SystemEvent): void {
    if (event.type !== 'session.escalation_created') return;
    if (event.escalation.type !== 'ask_human') return;

    const tracked = issueWatcherRepo.findBySessionId(event.sessionId);
    if (!tracked) return;

    void (async () => {
      try {
        const profile = profileStore.get(tracked.profileName);
        const client = issueClientFactory(profile);
        const payload = event.escalation.payload as { question?: string };
        const question = payload.question ?? 'Session needs human input.';
        await client.addComment(tracked.issueId, `**Session needs input:**\n\n${question}`);
      } catch (err) {
        logger.error(
          { err, sessionId: event.sessionId },
          'Failed to post escalation comment on issue',
        );
      }
    })();
  }

  return {
    start() {
      // Subscribe to session events for completion tracking
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
