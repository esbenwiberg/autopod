import { readFile, rm } from 'node:fs/promises';
import {
  DEFAULT_MAX_PR_FIX_ATTEMPTS,
  PROVIDER_FAILOVER_HANDOFF_PATH,
  WORKSPACE_PI_HANDOFF_PATH,
} from '@autopod/shared';
import type { PrMergeStatus } from '../interfaces/index.js';
import { shellQuote } from '../util/shell-quote.js';
import { agentToolingCachePaths } from './agent-tooling-cache-paths.js';
import { renderPiHandoffFile } from './continuation-policy.js';
import type { ContainerPrepared } from './provisioning-container.js';
import { normalizeCommitEmail } from './provisioning-materials.js';
import type { ProvisioningCaptured, ProvisioningLiveDependencies } from './provisioning-ports.js';
import { hasPendingProviderContinuation } from './recovery-context.js';
import { installReferenceSnapshots } from './reference-snapshots.js';
import {
  WORKSPACE_RUNTIME_CACHE_EXCLUDES,
  buildWorkspaceMirrorCopyScript,
} from './workspace-mirror.js';

type Captured = Pick<
  ProvisioningCaptured,
  'buildPrFixTask' | 'podRepo' | 'fixFeedbackRepo' | 'logger' | 'transition'
>;

export function createProvisioningWorkspacePopulation(
  deps: Pick<ProvisioningLiveDependencies, 'providerAttemptRepo' | 'launchConfiguration'>,
  captured: Captured,
) {
  const { buildPrFixTask, podRepo, fixFeedbackRepo, logger, transition } = captured;
  async function populateWorkspace(input: ContainerPrepared) {
    let {
      worktreePath,
      containerManager,
      containerId,
      podId,
      profile,
      pod,
      launchConfig,
      frozenReferences,
      stagedReferenceRepos,
      hostPreviewUrl,
    } = input;
    const { emitStatus } = input.run;
    // Copy worktree content from bind mount to container's native filesystem.
    // VirtioFS bind mounts break getcwd() on Docker Desktop for Mac — overlayfs does not.
    // Dependency/tooling caches are intentionally skipped: they contain native binaries
    // for the filesystem they were created on and must not cross the host/container boundary.
    // Skipped for artifact pods with no worktree.
    if (worktreePath) {
      emitStatus('Populating workspace…');
      // Strip the image's baked-in `/workspace/.git` first. The warm image is built
      // with `RUN git clone --depth 1` (dockerfile-generator.ts), which leaves a real
      // `.git` directory pinned to whatever main was at image-build time. The host
      // worktree carries a `.git` *gitlink file*, and `cp -a` cannot overwrite a
      // directory with a non-directory — it errors on that single entry, copies
      // everything else, and exits non-zero. If we don't pre-clear, the seam leaks
      // image-era HEAD into /workspace/.git/HEAD and the agent works against a stale
      // base. Pre-clearing makes cp's job collision-free.
      const preclear = await containerManager.execInContainer(
        containerId,
        ['rm', '-rf', '/workspace/.git'],
        { timeout: 30_000 },
      );
      if (preclear.exitCode !== 0) {
        throw new Error(
          `Workspace pre-clear failed (exit ${preclear.exitCode}): ${preclear.stderr}`,
        );
      }
      const populate = await containerManager.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          buildWorkspaceMirrorCopyScript(
            '/mnt/worktree',
            "'/workspace'",
            WORKSPACE_RUNTIME_CACHE_EXCLUDES,
          ),
        ],
        { timeout: 120_000 },
      );
      if (populate.exitCode !== 0) {
        throw new Error(
          `Workspace populate failed (exit ${populate.exitCode}): ${populate.stderr}`,
        );
      }
      // Restore execute bit on node_modules binaries — VirtioFS bind mounts on Docker Desktop
      // for Mac can strip +x from native platform binaries (e.g. @esbuild/linux-arm64/bin/esbuild).
      await containerManager
        .execInContainer(
          containerId,
          [
            'sh',
            '-c',
            'find /workspace \\( -path "*/node_modules/.bin/*" -o -path "*/node_modules/*/bin/*" \\) -type f -not -empty -exec chmod +x {} + 2>/dev/null || true',
          ],
          { timeout: 15_000 },
        )
        .catch(() => null);
      // Convert /workspace/.git from a gitlink file into a self-contained real .git
      // directory. The gitlink references a Mac host path that sub-processes
      // (e.g. Dagger CLI, go-git) can't follow when they don't inherit autopod's
      // bind mounts. A real .git directory works everywhere inside the container.
      // Objects are shared via alternates so no object copying is needed.
      const repoint = await containerManager.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          [
            'set -e',
            // Resolve bare worktree metadata dir and bare root from the gitlink
            "BARE_WT=$(sed 's/^gitdir: //' /workspace/.git | tr -d '\\n')",
            'BARE_COMMON=$(cat "${BARE_WT}/commondir" 2>/dev/null || echo "../..")',
            'BARE_ROOT=$(cd "${BARE_WT}/${BARE_COMMON}" && pwd)',
            // Replace the gitlink file with a real git directory
            'rm /workspace/.git',
            'mkdir -p /workspace/.git',
            // Seed it with the worktree-specific metadata (HEAD, index, logs, etc.)
            'cp -a "${BARE_WT}/." /workspace/.git/',
            // Strip the commondir/gitdir files — this is now a standalone git dir
            'rm -f /workspace/.git/commondir /workspace/.git/gitdir',
            // Wire alternates so git can read objects from the bare without copying them
            'mkdir -p /workspace/.git/objects/info',
            'echo "${BARE_ROOT}/objects" > /workspace/.git/objects/info/alternates',
            // Materialise refs from the bare (worktree metadata only has per-branch refs)
            'cp -a "${BARE_ROOT}/refs/." /workspace/.git/refs/ 2>/dev/null || true',
            'cp "${BARE_ROOT}/packed-refs" /workspace/.git/ 2>/dev/null || true',
          ].join(' && '),
        ],
        { timeout: 15_000 },
      );
      if (repoint.exitCode !== 0) {
        throw new Error(`Git workspace setup failed (exit ${repoint.exitCode}): ${repoint.stderr}`);
      }
      // Restore any tracked files missing from the working tree (M/D status).
      // syncWorkspaceBack() clears + re-copies the host bind-mount; if it dies mid-flight
      // (OOM, Docker crash, Azure SMB error) the host worktree loses files while the git
      // index still references them. Recovery mode then copies that partial tree into the
      // container. Skipped when the index is empty (new branch / unborn HEAD) — `git restore .`
      // errors with "pathspec '.' did not match any file(s) known to git" in that case.
      const hasTrackedFiles = await containerManager.execInContainer(
        containerId,
        ['sh', '-c', 'git -C /workspace ls-files | head -1 | grep -q .'],
        { timeout: 5_000 },
      );
      if (hasTrackedFiles.exitCode === 0) {
        const restore = await containerManager.execInContainer(
          containerId,
          ['git', '-C', '/workspace', 'restore', '.'],
          { timeout: 30_000 },
        );
        if (restore.exitCode !== 0) {
          throw new Error(
            `Git workspace restore failed (exit ${restore.exitCode}): ${restore.stderr}`,
          );
        }
      }

      const hasPendingHandoff = hasPendingProviderContinuation(
        deps.providerAttemptRepo?.list(podId),
      );
      if (hasPendingHandoff) {
        const marker = '# autopod: provider failover handoff';
        const guard = await containerManager.execInContainer(
          containerId,
          [
            'sh',
            '-c',
            [
              'set -e',
              `if [ ! -f ${shellQuote(`/workspace/${PROVIDER_FAILOVER_HANDOFF_PATH}`)} ]; then`,
              `  printf '%s\\n' ${shellQuote(`Missing pending provider failover handoff: /workspace/${PROVIDER_FAILOVER_HANDOFF_PATH}`)} >&2`,
              '  exit 1',
              'fi',
              'mkdir -p /workspace/.git/info',
              'touch /workspace/.git/info/exclude',
              `if ! grep -qFx ${shellQuote(PROVIDER_FAILOVER_HANDOFF_PATH)} /workspace/.git/info/exclude; then`,
              `  printf '\\n%s\\n%s\\n' ${shellQuote(marker)} ${shellQuote(PROVIDER_FAILOVER_HANDOFF_PATH)} >> /workspace/.git/info/exclude`,
              'fi',
              `git -C /workspace check-ignore -q ${shellQuote(PROVIDER_FAILOVER_HANDOFF_PATH)}`,
            ].join('\n'),
          ],
          { timeout: 10_000 },
        );
        if (guard.exitCode !== 0) {
          throw new Error(
            `Failed to protect provider failover handoff before workspace cleanup (exit ${guard.exitCode}): ${guard.stderr}`,
          );
        }
      }

      // Strip untracked files left behind by the warm image. The image is built with
      // `RUN git clone --depth 1` of the base branch at image-build time, then runs
      // pre-warm install + build, then `rm -rf /workspace/.git`. Source files from
      // that older clone stay in `/workspace/` as plain files. The earlier
      // The worktree mirror copy is additive — it never deletes — so any file that the
      // host worktree's branch has dropped (e.g. deleted in a later PR on main) survives
      // in `/workspace` as an untracked file. `git restore .` only touches tracked paths,
      // so it doesn't help.
      //
      // For workspace pods the leak is severe: on promote/handoff, syncWorkspaceBack's
      // mirror copy and the subsequent `git add -A` in commitPendingChanges sweep stale
      // files into a commit on the branch. For auto pods it shows up as build noise
      // (native build tools discover sources via filesystem walk) and reviewer scope creep.
      //
      // `-fd` (no `-x`): preserves gitignored caches like node_modules, bin/, obj/,
      // dist/, .next/ so subsequent build phases keep their incremental state.
      // Combined with the prior `cp -a` + `git restore .`, the worktree now contains
      // exactly what the branch tip has, plus the warm-image dependency caches —
      // and nothing else.
      const clean = await containerManager.execInContainer(
        containerId,
        ['git', '-C', '/workspace', 'clean', '-fd'],
        { timeout: 30_000 },
      );
      if (clean.exitCode !== 0) {
        // Non-fatal: a failure here means the agent may see stale untracked files,
        // which is the bug we are fixing — but it's still better than aborting
        // pod start. Log loudly so operators can correlate with downstream
        // contamination reports.
        logger.warn(
          {
            podId,
            exitCode: clean.exitCode,
            stderr: clean.stderr.slice(0, 500),
          },
          'git clean -fd failed in /workspace — image-baked untracked files may leak into the worktree',
        );
      }

      // Hide daemon-injected code-intel state (`.serena/`, `.roslyn-codelens/`, …)
      // from the agent's `git add -A`. The system instructions tell the agent to run
      // `git add -A && git commit` for normal commits — without this, those caches get
      // swept into the feature branch on pod A, then pod B's fresh container has no
      // such files, and host-side `git add -A` perceives the absence as a mass-deletion
      // and trips DeletionGuardError. We've seen this fire repeatedly in practice.
      //
      // Two-step protection inside the container:
      //   1. Add the paths to `.git/info/exclude` (repo-local, never tracked).
      //   2. `git rm --cached -r --ignore-unmatch` to detrack any entries a previous
      //      pod already committed (idempotent; no-op when nothing is tracked).
      // The .git/info/exclude write is idempotent via a `grep -qF` guard so re-runs
      // don't duplicate lines.
      const cachePaths = agentToolingCachePaths(profile.codeIntelligence);
      if (cachePaths.length > 0) {
        const marker = '# autopod: code-intel cache exclusions';
        const excludeLines = [marker, ...cachePaths.map((p) => `/${p}/`)].join('\n');
        const detrackArgs = cachePaths.flatMap((p) => [p]);
        const script = [
          'set -e',
          'mkdir -p /workspace/.git/info',
          'touch /workspace/.git/info/exclude',
          `if ! grep -qF ${shellQuote(marker)} /workspace/.git/info/exclude; then`,
          `  printf '\\n%s\\n' ${shellQuote(excludeLines)} >> /workspace/.git/info/exclude`,
          'fi',
          `git -C /workspace rm --cached -r --ignore-unmatch -- ${detrackArgs
            .map(shellQuote)
            .join(' ')} >/dev/null 2>&1 || true`,
        ].join('\n');
        const cacheGuard = await containerManager.execInContainer(
          containerId,
          ['sh', '-c', script],
          { timeout: 10_000 },
        );
        if (cacheGuard.exitCode !== 0) {
          // Non-fatal: worst case is the historical deletion-guard loop returns. Log
          // loudly so we can correlate if it ever fires after this lands.
          logger.warn(
            {
              podId,
              exitCode: cacheGuard.exitCode,
              stderr: cacheGuard.stderr.slice(0, 500),
              cachePaths,
            },
            'Failed to install code-intel cache exclusions in /workspace/.git/info/exclude',
          );
        }
      }

      // Mirror the pod's durable handoff instructions into the workspace at
      // /workspace/.autopod/pi-handoff.md so the interactive session (and,
      // after promotion, the agent) can read the Pi handoff without leaving
      // the container. Written *after* the populate/restore/clean sequence
      // so nothing clobbers it. Kept out of commits by two layers: the
      // shared worktree info/exclude (host-side auto-commit) set at worktree
      // creation, plus this in-container info/exclude entry — the container's
      // reconstructed /workspace/.git does NOT inherit the shared exclude, so
      // without this an in-container `git add -A` would still sweep it in.
      // Fail closed: a workspace that cannot surface or protect its handoff
      // is an inconsistent handoff, so both the write and the exclude throw.
      if (pod.handoffInstructions) {
        emitStatus('Writing handoff…');
        await containerManager.writeFile(
          containerId,
          WORKSPACE_PI_HANDOFF_PATH,
          renderPiHandoffFile(pod.handoffInstructions),
        );
        const marker = '# autopod: pi handoff';
        const guard = await containerManager.execInContainer(
          containerId,
          [
            'sh',
            '-c',
            [
              'set -e',
              'mkdir -p /workspace/.git/info',
              'touch /workspace/.git/info/exclude',
              `if ! grep -qF ${shellQuote(marker)} /workspace/.git/info/exclude; then`,
              `  printf '\\n%s\\n%s\\n' ${shellQuote(marker)} ${shellQuote('.autopod/pi-handoff.md')} >> /workspace/.git/info/exclude`,
              'fi',
            ].join('\n'),
          ],
          { timeout: 10_000 },
        );
        if (guard.exitCode !== 0) {
          throw new Error(
            `Failed to exclude pi-handoff.md from workspace commits (exit ${guard.exitCode}): ${guard.stderr}`,
          );
        }
      }

      if (hasPendingHandoff) {
        const marker = '# autopod: provider failover handoff';
        const guard = await containerManager.execInContainer(
          containerId,
          [
            'sh',
            '-c',
            [
              'set -e',
              `if [ ! -f ${shellQuote(`/workspace/${PROVIDER_FAILOVER_HANDOFF_PATH}`)} ]; then`,
              `  printf '%s\\n' ${shellQuote(`Missing pending provider failover handoff after workspace cleanup: /workspace/${PROVIDER_FAILOVER_HANDOFF_PATH}`)} >&2`,
              '  exit 1',
              'fi',
              'mkdir -p /workspace/.git/info',
              'touch /workspace/.git/info/exclude',
              `if ! grep -qFx ${shellQuote(PROVIDER_FAILOVER_HANDOFF_PATH)} /workspace/.git/info/exclude; then`,
              `  printf '\\n%s\\n%s\\n' ${shellQuote(marker)} ${shellQuote(PROVIDER_FAILOVER_HANDOFF_PATH)} >> /workspace/.git/info/exclude`,
              'fi',
              `git -C /workspace check-ignore -q ${shellQuote(PROVIDER_FAILOVER_HANDOFF_PATH)}`,
            ].join('\n'),
          ],
          { timeout: 10_000 },
        );
        if (guard.exitCode !== 0) {
          throw new Error(
            `Failed to protect provider failover handoff (exit ${guard.exitCode}): ${guard.stderr}`,
          );
        }
      }
    }

    // Pre-fill global git author identity so the user (or agent) doesn't hit
    // "Author identity unknown" the first time they `git commit`. Sourced
    // from the JWT claims captured at pod creation; falls back to a generic
    // identity for legacy pods or pre-auth code paths so commits never fail.
    {
      const email = normalizeCommitEmail(pod.creatorEmail) ?? 'autopod@autopod.local';
      const name = pod.creatorName?.trim() || 'Autopod User';
      const gitIdentity = await containerManager.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          `git config --global user.email ${shellQuote(email)} && git config --global user.name ${shellQuote(name)}`,
        ],
        { timeout: 5_000 },
      );
      if (gitIdentity.exitCode !== 0) {
        // Non-fatal: the worst case is the user re-runs the two commands manually.
        logger.warn(
          { podId, exitCode: gitIdentity.exitCode, stderr: gitIdentity.stderr.slice(0, 200) },
          'Failed to set global git author identity in container',
        );
      }
    }

    if (launchConfig && deps.launchConfiguration) {
      await deps.launchConfiguration.assertCurrentCapabilities(launchConfig);
      await installReferenceSnapshots(frozenReferences, containerManager, containerId);
      await deps.launchConfiguration.assertCurrentCapabilities(launchConfig);
    }
    // Clone reference repos into /repos/<mountPath> inside the container (read-only)
    const referenceRepos = launchConfig ? [] : (pod.referenceRepos ?? []);
    if (referenceRepos.length > 0) {
      emitStatus('Cloning reference repos…');
      await containerManager.execInContainer(containerId, ['mkdir', '-p', '/repos'], {
        timeout: 5_000,
      });
      for (const repo of referenceRepos) {
        const destPath = `/repos/${repo.mountPath}`;
        const staged = stagedReferenceRepos.get(repo.mountPath);
        try {
          if (staged) {
            try {
              await containerManager.writeFile(
                containerId,
                staged.containerArchive,
                await readFile(staged.archivePath),
              );
              await containerManager.execInContainer(containerId, ['mkdir', '-p', destPath], {
                timeout: 5_000,
              });
              await containerManager.execInContainer(
                containerId,
                ['tar', '-xzf', staged.containerArchive, '-C', destPath],
                { timeout: 60_000 },
              );
            } finally {
              await rm(staged.archivePath, { force: true });
              await containerManager
                .execInContainer(containerId, ['rm', '-f', staged.containerArchive], {
                  timeout: 5_000,
                })
                .catch(() => {});
            }
          } else {
            await containerManager.execInContainer(
              containerId,
              ['git', 'clone', '--depth', '1', repo.url, destPath],
              { timeout: 60_000 },
            );
          }
        } catch (err) {
          if (repo.sourceProfile) throw err;
          logger.warn({ err, podId, url: repo.url }, 'Failed to clone reference repo — skipping');
        }
      }
    }

    pod = transition(pod, 'running', {
      containerId,
      worktreePath,
      previewUrl: hostPreviewUrl,
      runningAt: new Date().toISOString(),
    });

    // Fix pods: drain any queued reviewer/CI feedback into the task before
    // the agent stream starts. `drain()` runs *after* the `running`
    // transition is committed — a crash between `provisioning` and
    // `running` leaves the queue intact for the next iteration to drain.
    if (pod.linkedPodId) {
      const parent = podRepo.getOrThrow(pod.linkedPodId);
      const maxAttempts = parent.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS;
      emitStatus(
        `Starting fix iteration ${pod.fixIteration ?? 0}, parent attempt ${parent.prFixAttempts ?? 0}/${maxAttempts}`,
      );
      const queued = fixFeedbackRepo.drain(pod.linkedPodId);
      if (queued.length > 0) {
        const userMessage = queued.map((m) => m.message).join('\n\n---\n\n');
        // The queued summaries already carry the CI/review content, so a
        // minimal status is sufficient — buildPrFixTask folds `userMessage`
        // into the task body.
        const minimalStatus: PrMergeStatus = {
          merged: false,
          open: true,
          blockReason: 'PR needs fixes',
          ciFailures: [],
          reviewComments: [],
        };
        const fixTask = buildPrFixTask(pod, minimalStatus, podRepo, profile, userMessage);
        podRepo.update(pod.id, { task: fixTask });
        pod = podRepo.getOrThrow(pod.id);
      }
    }
    return { ...input, kind: 'ready' as const, pod, launchConfig, profile };
  }
  return { populateWorkspace };
}

export type PopulatedWorkspace = Extract<
  Awaited<
    ReturnType<ReturnType<typeof createProvisioningWorkspacePopulation>['populateWorkspace']>
  >,
  { kind: 'ready' }
>;
