import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';
import { collectImplementationIdentity } from './src/runtimes/build-input-identity.js';

let commitSha: string | null = null;
let dirty: boolean | null = null;
try {
  const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (/^[a-f0-9]{40}$/.test(candidate)) commitSha = candidate;
  dirty =
    execFileSync(
      'git',
      [
        'status',
        '--porcelain',
        '--',
        ':(top)packages',
        ':(top)package.json',
        ':(top)pnpm-lock.yaml',
        ':(top)pnpm-workspace.yaml',
        ':(top)turbo.json',
        ':(top)tsconfig.base.json',
      ],
      { encoding: 'utf8' },
    ).trim().length > 0;
} catch {
  /* copied source with no git evidence is explicitly unidentified */
}
const release = {
  validationImplementationHash: collectImplementationIdentity(),
  commitSha,
  dirty,
  builtAt: new Date().toISOString(),
  source: commitSha ? 'build' : 'unavailable',
};

export default defineConfig({
  define: { __AUTOPOD_RELEASE__: JSON.stringify(release) },
  entry: [
    'src/index.ts',
    'src/managed.ts',
    'src/db/verify-backup-cli.ts',
    'src/db/recover-merge-cli.ts',
    'src/db/recover-merged-fix-cli.ts',
    'src/db/reconcile-native-checkpoint-cli.ts',
    'src/configuration/conversion-cli.ts',
    'src/configuration/cutover-cli.ts',
    // Executable entry declarations can erase private implementation imports.
    // Keep critical recovery/configuration/auth modules checked by normal CI too.
    ...(process.env.AUTOPOD_TYPECHECK === '1'
      ? [
          'src/actions/deployment-run-repository.ts',
          'src/api/routes/scheduled-jobs.ts',
          'src/api/routes/validation-recovery.ts',
          'src/api/types.ts',
          'src/configuration/conversion-bindings.ts',
          'src/configuration/components.ts',
          'src/configuration/derive-launch.ts',
          'src/configuration/host-components.ts',
          'src/configuration/series-launches.ts',
          'src/containers/docker-network-manager.ts',
          'src/github/read-broker.ts',
          'src/issue-watcher/issue-watcher-service.ts',
          'src/managed/codex-wire.ts',
          'src/pods/admission-memory-briefing.ts',
          'src/pods/approval-delivery-execution.ts',
          'src/pods/completion-guards.ts',
          'src/pods/completion-ports.ts',
          'src/pods/fix-admission.ts',
          'src/pods/pod-manager.ts',
          'src/pods/pod-repository.ts',
          'src/pods/quality-score-repository.ts',
          'src/pods/source-adoption-controller.ts',
          'src/pods/task-execution-ledger.ts',
          'src/pods/resource-cleanup.ts',
          'src/pods/workspace-recovery-commands.ts',
          'src/pods/validation-workflow-controls.ts',
          'src/pods/validation-pass-delivery.ts',
          'src/pods/revalidation-pass-delivery.ts',
          'src/pods/validation-trigger-workflow.ts',
          'src/validation/local-validation-engine.ts',
          'src/validation/override-applicator.ts',
          'src/pods/validation-publication.ts',
          'src/pods/validation-revalidation-workflow.ts',
          'src/pods/validation-evidence.ts',
          'src/pods/validation-execution.ts',
          'src/pods/validation-execution-ledger.ts',
          'src/pods/validation-execution-evidence.ts',
          'src/pods/validation-execution-recovery.ts',
          'src/pods/validation-recovery-policy.ts',
          'src/pods/validation-recovery-reports.ts',
          'src/pods/workspace-checkpoint-controller.ts',
          'src/pods/control-operation-registry.ts',
          'src/pods/event-bus.ts',
          'src/pods/source-custody-guards.ts',
          'src/api/routes/terminal.ts',
          'src/containers/azure-sandbox-api-client.ts',
          'src/containers/sandbox-container-manager.ts',
          'src/pods/advisory-validation.ts',
          'src/pods/fix-delivery.ts',
          'src/pods/workspace-deletion.ts',
          'src/pods/resource-commit-polling.ts',
          'src/pods/resource-preview-controls.ts',
          'src/pods/resource-preview.ts',
          'src/pods/resource-preview-timers.ts',
          'src/pods/sandbox-preview-proxy.ts',
          'src/pods/workspace-preservation.ts',
          'src/pods/workspace-transfer.ts',
          'src/worktrees/sandbox-workspace-checkpoint.ts',
          'src/worktrees/bare-push.ts',
          'src/providers/credential-persistence.ts',
          'src/providers/env-builder.ts',
          'src/providers/memory-reviewer.ts',
          'src/scheduled-jobs/scheduled-job-manager.ts',
          'src/validation/reviewer-run-repository.ts',
          'src/worktrees/diff-utils.ts',
          'src/worktrees/local-worktree-manager.ts',
        ]
      : []),
  ],
  format: ['esm'],
  dts:
    process.env.AUTOPOD_TYPECHECK === '1'
      ? {
          only: true,
          compilerOptions: { types: ['node', resolve('src/api/type-context')] },
        }
      : true,
  clean: true,
  sourcemap: true,
  external: ['better-sqlite3', 'pino-pretty'],
  onSuccess: async () => {
    if (process.env.AUTOPOD_TYPECHECK === '1') return;
    mkdirSync('dist/db/migrations', { recursive: true });
    cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
    mkdirSync('dist/db/fixtures/native-reliability-151-163', { recursive: true });
    cpSync(
      'src/db/fixtures/native-reliability-151-163',
      'dist/db/fixtures/native-reliability-151-163',
      { recursive: true },
    );
    mkdirSync('dist/actions/defaults', { recursive: true });
    cpSync('src/actions/defaults', 'dist/actions/defaults', { recursive: true });
    mkdirSync('dist/runtime', { recursive: true });
    cpSync('src/managed/runtime/supervisor.py', 'dist/runtime/supervisor.py');
    cpSync('src/managed/runtime/validation-supervisor.py', 'dist/runtime/validation-supervisor.py');
    cpSync('src/managed/runtime/codex_channel.py', 'dist/runtime/codex_channel.py');
    cpSync('src/managed/runtime/codex_worker.py', 'dist/runtime/codex_worker.py');
    cpSync('src/managed/runtime/codex_agent_worker.py', 'dist/runtime/codex_agent_worker.py');
    cpSync('src/managed/runtime/github_cli.py', 'dist/runtime/github_cli.py');
    cpSync('src/managed/runtime/public_read.py', 'dist/runtime/public_read.py');
    mkdirSync('dist/containers', { recursive: true });
    cpSync('src/containers/seccomp-profile.json', 'dist/containers/seccomp-profile.json');
    mkdirSync('dist/images', { recursive: true });
    cpSync('src/images/image-digests.json', 'dist/images/image-digests.json');
    cpSync('src/images/dagger-cli-version.json', 'dist/images/dagger-cli-version.json');
  },
});
