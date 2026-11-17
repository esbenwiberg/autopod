import { randomUUID } from 'node:crypto';
import { AutopodError, type Pod, type ValidationResult } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { BranchPublicationSource } from '../interfaces/worktree-manager.js';
import { assertMergeTarget } from '../worktrees/merge-source-identity.js';
import { inspectAdoptionGit } from '../worktrees/source-adoption-git.js';
import { recoveryCheckHash } from './recovery-fork-checks.js';
import { failedValidationPhases, hasPendingFactDecision } from './validation-workflow-policy.js';

function deterministicCheckHash(result: ValidationResult): string {
  const value = structuredClone(result);
  value.taskReview = null;
  value.overall = 'pass';
  value.duration = 0;
  delete value.reviewTokenUsage;
  delete value.reviewSkipKind;
  delete value.reviewSkipReason;
  return recoveryCheckHash(value);
}

export interface CheckedSource {
  head: string;
  tree: string;
}
export function publicSourceRepository(raw: string): string {
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url
    .toString()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}
/** An unavailable observation grants no publication or historical delivery authority. */
export async function observeValidationSource(
  cm: ContainerManager,
  pod: Pod,
): Promise<CheckedSource | null> {
  if (!pod.containerId || !pod.worktreePath) return null;
  const containerId = pod.containerId;
  try {
    return await inspectAdoptionGit(async (args) => {
      const result = await cm.execInContainer(
        containerId,
        // Git is already a worker prerequisite. Avoid requiring an additional
        // language runtime and discard inherited Git/auth/executable settings.
        [
          '/usr/bin/env',
          '-i',
          'AUTOPOD_SOURCE_PROBE=autopod-validation-source-v1',
          `AUTOPOD_EXPECTED_BRANCH=${pod.branch}`,
          'PATH=/usr/bin:/bin',
          'GIT_CONFIG_NOSYSTEM=1',
          'GIT_CONFIG_GLOBAL=/dev/null',
          'GIT_OPTIONAL_LOCKS=0',
          'GIT_NO_REPLACE_OBJECTS=1',
          'GIT_NO_LAZY_FETCH=1',
          'GIT_TERMINAL_PROMPT=0',
          '/usr/bin/git',
          '-C',
          '/workspace',
          ...args,
        ],
        { cwd: '/workspace', timeout: 15_000, maxOutputBytes: 4 * 1024 * 1024 },
      );
      if (result.exitCode !== 0) throw new Error('Validation source observation unavailable');
      return result;
    }, pod.branch);
  } catch {
    return null;
  }
}
export function validationSourceError(detail: string): never {
  throw new AutopodError(
    `Exact validation-source evidence unavailable. ${detail} Retain source and reports; inspect source-recovery and the owning validation/rewrite operation. A coding rerun is not delivery proof.`,
    'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
    409,
  );
}
export function createValidationSourceEvidence(db: Database.Database) {
  const binding = (pod: Pod, profile: Pick<PodExecutionSettings, 'repoUrl' | 'defaultBranch'>) => {
    const execution = db
      .prepare('SELECT task_id FROM task_executions WHERE pod_id=?')
      .get(pod.id) as { task_id: string } | undefined;
    if (!execution) validationSourceError('Task identity is missing.');
    return {
      podId: pod.id,
      taskId: execution.task_id,
      taskHash: configurationDigest(pod.task),
      generation: pod.lifecycleGeneration,
      containerId: pod.containerId,
      worktreePath: pod.worktreePath,
      executionTarget: pod.executionTarget,
      launchDigest: pod.launchConfigDigest,
      branch: pod.branch,
      baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
      repository: profile.repoUrl ? publicSourceRepository(profile.repoUrl) : null,
      options: pod.options,
    };
  };
  const ledger = {
    begin(pod: Pod, profile: PodExecutionSettings, source: CheckedSource, admissionId: string) {
      const started = db
        .prepare(
          "SELECT 1 FROM task_retry_attempts WHERE id=? AND pod_id=? AND generation=? AND stage='validation' AND started_at IS NOT NULL AND ended_at IS NULL",
        )
        .get(admissionId, pod.id, pod.lifecycleGeneration);
      if (!started) validationSourceError('A started validation admission is required.');
      const id = randomUUID();
      db.prepare('INSERT INTO validation_source_intents VALUES(?,?,?,?,?)').run(
        id,
        pod.id,
        pod.lifecycleGeneration,
        JSON.stringify({ ...binding(pod, profile), source, admissionId }),
        new Date().toISOString(),
      );
      return id;
    },
    finish(
      id: string,
      pod: Pod,
      profile: PodExecutionSettings,
      source: CheckedSource,
      result: ValidationResult,
    ) {
      const row = db.prepare('SELECT binding FROM validation_source_intents WHERE id=?').get(id) as
        | { binding: string }
        | undefined;
      const { admissionId, ...saved } = JSON.parse(row?.binding ?? '{}');
      if (
        !row ||
        configurationDigest(saved) !== configurationDigest({ ...binding(pod, profile), source })
      )
        return;
      const started = db
        .prepare(
          "SELECT 1 FROM task_retry_attempts WHERE id=? AND pod_id=? AND generation=? AND stage='validation' AND started_at IS NOT NULL AND ended_at IS NULL",
        )
        .get(admissionId, pod.id, pod.lifecycleGeneration);
      if (!started || result.podId !== pod.id || result.infrastructureFailure) return;
      db.prepare('INSERT INTO validation_source_results VALUES(?,?,?,?)').run(
        id,
        recoveryCheckHash(result),
        JSON.stringify(result),
        new Date().toISOString(),
      );
    },
    /** Append a NEW native adjudication witness; never rewrite the failed check or its accounting. */
    adjudicate(
      pod: Pod,
      profile: PodExecutionSettings,
      before: CheckedSource,
      after: CheckedSource,
      original: ValidationResult,
      independent: ValidationResult,
      effective: ValidationResult,
    ): void {
      const adjudication = effective.taskReview?.reviewBatch?.adjudication;
      if (
        pod.skipValidation ||
        pod.validationWaiver ||
        pod.validationOverrides?.length ||
        original.overall !== 'fail' ||
        original.infrastructureFailure ||
        original.taskReview?.reviewBatch?.quality !== 'healthy' ||
        original.taskReview.reviewBatch.infrastructureUnavailable ||
        original.taskReview.reviewBatch.reviewedHead !== before.head ||
        failedValidationPhases(original).join(',') !== 'review' ||
        hasPendingFactDecision(original) ||
        effective.podId !== pod.id ||
        effective.overall !== 'pass' ||
        effective.taskReview?.status !== 'pass' ||
        effective.taskReview.issues.length ||
        effective.taskReview.requirementsCheck?.some((item) => !item.met) ||
        deterministicCheckHash(original) !== deterministicCheckHash(effective) ||
        independent.podId !== pod.id ||
        independent.attempt !== original.attempt ||
        effective.attempt !== original.attempt ||
        independent.infrastructureFailure ||
        independent.taskReview?.reviewBatch?.quality !== 'healthy' ||
        independent.taskReview.reviewBatch.infrastructureUnavailable ||
        independent.taskReview.reviewBatch.reviewedHead !== before.head ||
        adjudication?.kind !== 'recurrence-hoist' ||
        !adjudication.candidateFindingIds.length ||
        adjudication.confirmedFindingIds.length ||
        adjudication.originalReviewBatchId !== original.taskReview?.reviewBatch?.id ||
        configurationDigest(before) !== configurationDigest(after)
      )
        return;
      const expected = configurationDigest({ ...binding(pod, profile), source: before });
      const rows = db
        .prepare(`SELECT i.id,i.binding,r.result_hash FROM validation_source_intents i
        JOIN validation_source_results r ON r.intent_id=i.id WHERE i.pod_id=? AND i.generation=? ORDER BY i.rowid DESC`)
        .all(pod.id, pod.lifecycleGeneration) as Array<{
        id: string;
        binding: string;
        result_hash: string;
      }>;
      for (const row of rows) {
        const { admissionId, ...saved } = JSON.parse(row.binding);
        if (
          row.result_hash !== recoveryCheckHash(original) ||
          configurationDigest(saved) !== expected
        )
          continue;
        const settled = db
          .prepare(`SELECT 1 FROM task_retry_attempts a WHERE id=? AND pod_id=? AND generation=?
          AND stage='validation' AND outcome='nonretryable' AND started_at IS NOT NULL AND ended_at IS NOT NULL
          AND id=(SELECT id FROM task_retry_attempts WHERE task_id=a.task_id AND stage='validation' ORDER BY rowid DESC LIMIT 1)`)
          .get(admissionId, pod.id, pod.lifecycleGeneration);
        if (!settled) return;
        const id = randomUUID();
        db.transaction(() => {
          db.prepare('INSERT INTO validation_source_intents VALUES(?,?,?,?,?)').run(
            id,
            pod.id,
            pod.lifecycleGeneration,
            JSON.stringify({
              ...saved,
              admissionId,
              adjudication: {
                originalIntentId: row.id,
                originalResultHash: row.result_hash,
                independentReview: independent,
              },
            }),
            new Date().toISOString(),
          );
          db.prepare('INSERT INTO validation_source_results VALUES(?,?,?,?)').run(
            id,
            recoveryCheckHash(effective),
            JSON.stringify(effective),
            new Date().toISOString(),
          );
        })();
        return;
      }
    },
    checked(
      pod: Pod,
      profile: Pick<PodExecutionSettings, 'repoUrl' | 'defaultBranch'>,
    ): CheckedSource & { validationId: string } {
      const current = db
        .prepare(`SELECT status,lifecycle_generation,container_id,worktree_path,execution_target,
        task,branch,base_branch,launch_config_digest,last_validation_result,agent_mode,output_target,validate,validation_suite
        FROM pods WHERE id=?`)
        .get(pod.id) as Record<string, unknown> | undefined;
      let projectedHash: string;
      let currentHash: string;
      try {
        projectedHash = recoveryCheckHash(pod.lastValidationResult);
        currentHash = recoveryCheckHash(
          current?.last_validation_result
            ? JSON.parse(String(current.last_validation_result))
            : null,
        );
      } catch {
        return validationSourceError(
          'The stored validation projection is malformed or incomplete.',
        );
      }
      if (
        !current ||
        current.status !== pod.status ||
        current.lifecycle_generation !== pod.lifecycleGeneration ||
        current.container_id !== pod.containerId ||
        current.worktree_path !== pod.worktreePath ||
        current.execution_target !== pod.executionTarget ||
        current.task !== pod.task ||
        current.branch !== pod.branch ||
        current.base_branch !== pod.baseBranch ||
        current.launch_config_digest !== pod.launchConfigDigest ||
        current.agent_mode !== pod.options.agentMode ||
        current.output_target !== pod.options.output ||
        Boolean(current.validate) !== pod.options.validate ||
        (current.validation_suite ?? (current.validate ? 'full' : 'off')) !==
          pod.options.validationSuite ||
        currentHash !== projectedHash
      )
        validationSourceError(
          'Current validation projection or source ownership changed after source certification.',
        );
      const rows = db
        .prepare(
          `SELECT i.id,i.binding,r.result_hash FROM validation_source_intents i JOIN validation_source_results r ON r.intent_id=i.id WHERE i.pod_id=? AND i.generation=? ORDER BY i.rowid DESC`,
        )
        .all(pod.id, pod.lifecycleGeneration) as {
        id: string;
        binding: string;
        result_hash: string;
      }[];
      for (const row of rows) {
        const saved = JSON.parse(row.binding);
        const { source, admissionId, adjudication, ...identity } = saved;
        const settled = db
          .prepare(
            "SELECT 1 FROM task_retry_attempts a WHERE id=? AND pod_id=? AND generation=? AND stage='validation' AND outcome=? AND ended_at IS NOT NULL AND id=(SELECT id FROM task_retry_attempts WHERE task_id=a.task_id AND stage='validation' ORDER BY rowid DESC LIMIT 1)",
          )
          .get(
            admissionId,
            pod.id,
            pod.lifecycleGeneration,
            adjudication ? 'nonretryable' : 'pass',
          );
        if (!settled) continue;
        if (
          row.result_hash !== recoveryCheckHash(pod.lastValidationResult) ||
          pod.lastValidationResult?.overall !== 'pass'
        )
          continue;
        if (configurationDigest(identity) !== configurationDigest(binding(pod, profile))) continue;
        assertMergeTarget(
          {
            repository: profile.repoUrl ?? '',
            branch: pod.branch,
            baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
          },
          saved,
        );
        return { ...source, validationId: row.id };
      }
      return validationSourceError(
        'No immutable passing result binds this task, generation, target and original resource to its exact commit/tree.',
      );
    },
    bindPublication(
      pod: Pod,
      profile: Pick<PodExecutionSettings, 'repoUrl' | 'defaultBranch'>,
      publicationId: string,
      source: BranchPublicationSource,
      checkpoints: string[],
    ) {
      const checked = ledger.checked(pod, profile);
      if (
        source.treeSha !== checked.tree ||
        (source.commitSha !== checked.head &&
          (!checkpoints.length || checkpoints[0] !== source.commitSha))
      )
        validationSourceError(
          'Publication source has no exact checked identity or owned no-op checkpoint bridge.',
        );
      db.prepare('INSERT OR IGNORE INTO validation_source_publications VALUES(?,?,?)').run(
        publicationId,
        checked.validationId,
        JSON.stringify(checkpoints),
      );
      const saved = db
        .prepare(
          'SELECT validation_id,checkpoints FROM validation_source_publications WHERE publication_id=? AND validation_id=?',
        )
        .get(publicationId, checked.validationId) as { validation_id: string; checkpoints: string };
      if (
        saved.validation_id !== checked.validationId ||
        saved.checkpoints !== JSON.stringify(checkpoints)
      )
        validationSourceError('Publication already belongs to different checked source evidence.');
    },
  };
  return ledger;
}
export type ValidationSourceEvidence = ReturnType<typeof createValidationSourceEvidence>;
