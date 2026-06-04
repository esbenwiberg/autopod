import { spawn } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Pod, PodStatus, PublicProfile } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { IPty } from 'node-pty';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';
import { saveClipboardImage } from '../utils/clipboard.js';
import { resolvePodId } from '../utils/id-resolver.js';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.heic',
]);

const DEFAULT_ATTACH_TIMEOUT_MS = 10 * 60 * 1000;
const ATTACH_POLL_INTERVAL_MS = 1_500;
const TERMINAL_STATUSES = new Set<PodStatus>(['complete', 'killed', 'failed']);

type AttachSessionRunner = (containerName: string) => Promise<number>;
type ProfilePicker = (client: AutopodClient) => Promise<string>;
type SleepFn = (ms: number) => Promise<void>;
type NowFn = () => number;

interface WorkspaceCommandDeps {
  runAttachSession?: AttachSessionRunner;
  pickProfile?: ProfilePicker;
  sleep?: SleepFn;
  now?: NowFn;
}

interface ResolvedWorkspaceCommandDeps {
  attachSession: AttachSessionRunner;
  pickProfile: ProfilePicker;
  sleep: SleepFn;
  now: NowFn;
}

interface WorkspaceCreateOptions {
  attach?: boolean;
  branch?: string;
  label?: string;
  pimGroup?: string[];
  timeout?: number;
}

function attachDebug(msg: string): void {
  if (process.env.AUTOPOD_ATTACH_DEBUG === '1') {
    process.stderr.write(`[autopod:attach] ${msg}\n`);
  }
}

export function registerWorkspaceCommands(
  program: Command,
  getClient: () => AutopodClient,
  deps: WorkspaceCommandDeps = {},
): void {
  const attachSession = deps.runAttachSession ?? runAttachSession;
  const pickProfile = deps.pickProfile ?? pickProfileInteractively;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  // ap workspace <profile> [label]
  addWorkspaceOptions(
    program
      .command('workspace <profile> [label]')
      .description('Create a workspace pod — an interactive container with no agent'),
  )
    .option('--attach', 'Wait for the container and attach as soon as it is running')
    .action(async (profile: string, label: string | undefined, opts: WorkspaceCreateOptions) => {
      const client = getClient();
      await createWorkspacePod(client, profile, label, opts, {
        attachSession,
        pickProfile,
        sleep,
        now,
      });
    });

  // ap shell [profile]
  addWorkspaceOptions(
    program.command('shell [profile]').description('Create an interactive pod and attach to it'),
  ).action(async (profile: string | undefined, opts: WorkspaceCreateOptions) => {
    const client = getClient();
    const selectedProfile = profile ?? (await pickProfile(client));
    await createWorkspacePod(
      client,
      selectedProfile,
      undefined,
      { ...opts, attach: true },
      {
        attachSession,
        pickProfile,
        sleep,
        now,
      },
    );
  });

  // ap attach <id>
  program
    .command('attach <id>')
    .description('Attach to a running workspace pod via docker exec')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      const pod = await client.getSession(resolvedId);

      await attachToRunningPod(client, pod, attachSession);
    });

  // ap complete <id>
  //
  // With no flag: push the branch and transition to `complete`.
  // With --pr / --artifact / --none: promote the pod in-place to an
  // agent-driven run on the same ID (branch, events, token budget preserved).
  program
    .command('complete <id>')
    .description('Complete an interactive pod — push branch, or hand off to the agent')
    .option('--pr', 'Hand off to the agent and open a PR when it finishes')
    .option('--artifact', 'Hand off to the agent in artifact mode (no PR)')
    .option('--none', 'Hand off to the agent ephemerally (no push)')
    .option(
      '-i, --instructions <text>',
      'Handoff instructions for the agent (only used with --pr/--artifact/--none)',
    )
    .option(
      '--skip-agent',
      'Promote without spawning the agent — go straight to validation/PR with the human work as-is. Requires --pr or --artifact.',
    )
    .action(
      async (
        id: string,
        opts: {
          pr?: boolean;
          artifact?: boolean;
          none?: boolean;
          instructions?: string;
          skipAgent?: boolean;
        },
      ) => {
        const client = getClient();
        const resolvedId = await resolvePodId(client, id);
        const pod = await client.getSession(resolvedId);

        if (pod.options?.agentMode !== 'interactive' && pod.outputMode !== 'workspace') {
          console.error(chalk.red(`Pod ${resolvedId} is not an interactive pod.`));
          process.exit(1);
        }

        if (pod.status !== 'running') {
          console.error(
            chalk.red(`Pod ${resolvedId} is ${pod.status} — can only complete running pods.`),
          );
          process.exit(1);
        }

        const promoteFlags = [opts.pr, opts.artifact, opts.none].filter(Boolean).length;
        if (promoteFlags > 1) {
          console.error(chalk.red('Choose at most one of --pr, --artifact, --none'));
          process.exit(1);
        }
        const promoteTo = opts.pr
          ? ('pr' as const)
          : opts.artifact
            ? ('artifact' as const)
            : opts.none
              ? ('none' as const)
              : undefined;

        if (opts.skipAgent && !promoteTo) {
          console.error(
            chalk.red('--skip-agent requires a promotion target (--pr or --artifact).'),
          );
          process.exit(1);
        }
        if (opts.skipAgent && opts.none) {
          console.error(
            chalk.red('--skip-agent has no effect with --none (no PR, no push, no artifact).'),
          );
          process.exit(1);
        }

        const trimmedInstructions = opts.instructions?.trim();
        if (trimmedInstructions && !promoteTo) {
          console.log(
            chalk.yellow(
              'Note: --instructions is only used when handing off (--pr / --artifact / --none); ignored for plain branch push.',
            ),
          );
        }
        if (trimmedInstructions && opts.skipAgent) {
          console.log(
            chalk.yellow(
              'Note: --instructions is recorded for audit but the agent is skipped — instructions will not drive any work.',
            ),
          );
        }

        console.log();
        const completion = await withSpinner(
          promoteTo
            ? opts.skipAgent
              ? `Promoting pod to ${promoteTo} (no agent)…`
              : `Promoting pod to ${promoteTo}…`
            : 'Completing pod…',
          () =>
            client.completeSession(
              resolvedId,
              promoteTo
                ? {
                    promoteTo,
                    ...(trimmedInstructions ? { instructions: trimmedInstructions } : {}),
                    ...(opts.skipAgent ? { skipAgent: true } : {}),
                  }
                : undefined,
            ),
        );

        if (completion.promotedTo) {
          console.log(
            chalk.green(`Pod handed off. Agent will take over in ${completion.promotedTo} mode.`),
          );
          console.log(chalk.dim(`Track progress: ap status ${resolvedId.slice(0, 8)}`));
          return;
        }

        if (completion.pushError) {
          console.log(
            chalk.yellow(`Pod complete, but branch push failed: ${completion.pushError}`),
          );
          console.log(chalk.dim('You can push manually from the worktree.'));
        } else {
          console.log(chalk.green('Pod complete. Branch pushed to origin.'));
        }
      },
    );

  // ap inject <id> github|ado
  program
    .command('inject <id> <service>')
    .description('Inject provider credentials into a running container (github or ado)')
    .action(async (id: string, service: string) => {
      if (service !== 'github' && service !== 'ado') {
        console.error(chalk.red('service must be "github" or "ado"'));
        process.exit(1);
      }

      const client = getClient();
      const resolvedId = await resolvePodId(client, id);

      // Wait up to 60s for the container to reach 'running' before injecting
      const WAIT_TIMEOUT_MS = 60_000;
      const POLL_INTERVAL_MS = 1_500;
      const deadline = Date.now() + WAIT_TIMEOUT_MS;

      await withSpinner(`Injecting ${service} credentials…`, async () => {
        while (true) {
          const pod = await client.getSession(resolvedId);
          if (pod.status === 'running') break;

          const terminalStates = ['complete', 'killed', 'failed'];
          if (terminalStates.includes(pod.status)) {
            const err = new Error(
              `Pod ${resolvedId.slice(0, 8)} is ${pod.status} — cannot inject credentials.`,
            );
            throw err;
          }

          if (Date.now() >= deadline) {
            throw new Error(
              `Pod ${resolvedId.slice(0, 8)} is still ${pod.status} after ${WAIT_TIMEOUT_MS / 1000}s — container may have failed to start.`,
            );
          }

          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        await client.injectCredential(resolvedId, service as 'github' | 'ado');
      });

      console.log(
        chalk.green(`Done. ${service} credentials injected into pod ${resolvedId.slice(0, 8)}.`),
      );
      console.log(
        chalk.dim(
          'git and CLI tools are now authenticated. Credentials are gone when the container stops.',
        ),
      );
    });

  // ap install <id> gh|az
  program
    .command('install <id> <tool>')
    .description('Install gh or az CLI into a running container (no credentials)')
    .action(async (id: string, tool: string) => {
      if (tool !== 'gh' && tool !== 'az') {
        console.error(chalk.red('tool must be "gh" or "az"'));
        process.exit(1);
      }

      const client = getClient();
      const resolvedId = await resolvePodId(client, id);

      const WAIT_TIMEOUT_MS = 60_000;
      const POLL_INTERVAL_MS = 1_500;
      const deadline = Date.now() + WAIT_TIMEOUT_MS;

      await withSpinner(`Installing ${tool} CLI into pod ${resolvedId.slice(0, 8)}…`, async () => {
        while (true) {
          const pod = await client.getSession(resolvedId);
          if (pod.status === 'running') break;

          const terminalStates = ['complete', 'killed', 'failed'];
          if (terminalStates.includes(pod.status)) {
            throw new Error(
              `Pod ${resolvedId.slice(0, 8)} is ${pod.status} — cannot install tools.`,
            );
          }

          if (Date.now() >= deadline) {
            throw new Error(
              `Pod ${resolvedId.slice(0, 8)} is still ${pod.status} after ${WAIT_TIMEOUT_MS / 1000}s — container may have failed to start.`,
            );
          }

          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        await client.installCliTool(resolvedId, tool as 'gh' | 'az');
      });

      console.log(chalk.green(`Done. ${tool} CLI installed in pod ${resolvedId.slice(0, 8)}.`));
    });
}

function addWorkspaceOptions(command: Command): Command {
  return command
    .option(
      '-b, --branch <name>',
      'Name for the new working branch (defaults to autopod/<id>). Pass --base-branch on "ap run" for the handoff, not here.',
    )
    .option(
      '--pim-group <spec>',
      'PIM group to activate: <groupId> or <groupId:displayName> (repeatable)',
      collectRepeatable,
      [] as string[],
    )
    .option('--label <text>', 'Label shown in pod lists and status output')
    .option(
      '--timeout <seconds>',
      'Seconds to wait for the workspace container before attaching',
      parseTimeoutSeconds,
      DEFAULT_ATTACH_TIMEOUT_MS,
    );
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function parseTimeoutSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--timeout must be a positive whole number of seconds');
  }
  return parsed * 1000;
}

function parsePimGroups(specs: string[] | undefined):
  | {
      groupId: string;
      displayName?: string;
    }[]
  | undefined {
  if (!specs?.length) return undefined;
  return specs.map((spec) => {
    const colonIdx = spec.indexOf(':');
    if (colonIdx === -1) return { groupId: spec };
    return {
      groupId: spec.slice(0, colonIdx),
      displayName: spec.slice(colonIdx + 1),
    };
  });
}

async function pickProfileInteractively(client: AutopodClient): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Profile is required when stdin is not interactive. Try: ap shell <profile>');
  }

  const profiles = await withSpinner('Fetching profiles...', () => client.listProfiles());
  if (profiles.length === 0) {
    throw new Error('No profiles found. Create one with: ap profile create');
  }

  const sortedProfiles = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  if (sortedProfiles.length === 1) {
    const [profile] = sortedProfiles;
    console.log(chalk.dim(`Using only profile: ${profile.name}`));
    return profile.name;
  }

  console.log(chalk.bold('Select profile:'));
  sortedProfiles.forEach((profile, index) => {
    console.log(
      `  ${chalk.cyan(String(index + 1).padStart(2, ' '))}. ${formatProfileChoice(profile)}`,
    );
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question(chalk.cyan('Profile: '))).trim();
      if (!answer) continue;

      if (/^\d+$/.test(answer)) {
        const profile = sortedProfiles[Number.parseInt(answer, 10) - 1];
        if (profile) return profile.name;
      }

      const exactMatch = sortedProfiles.find((profile) => profile.name === answer);
      if (exactMatch) return exactMatch.name;

      console.log(
        chalk.yellow(`Choose 1-${sortedProfiles.length} or enter an exact profile name.`),
      );
    }
  } finally {
    rl.close();
  }
}

function formatProfileChoice(profile: PublicProfile): string {
  const details = [
    profile.extends ? `extends ${profile.extends}` : profile.template,
    profile.repoUrl?.replace(/^https?:\/\//, ''),
  ].filter(Boolean);
  return details.length
    ? `${chalk.bold(profile.name)} ${chalk.dim(`(${details.join(', ')})`)}`
    : chalk.bold(profile.name);
}

async function createWorkspacePod(
  client: AutopodClient,
  profile: string,
  positionalLabel: string | undefined,
  opts: WorkspaceCreateOptions,
  deps: ResolvedWorkspaceCommandDeps,
): Promise<void> {
  const label = opts.label ?? positionalLabel ?? 'Workspace pod';
  const pod = await withSpinner('Creating workspace pod...', () =>
    client.createSession({
      profileName: profile,
      task: label,
      outputMode: 'workspace',
      branch: opts.branch,
      pimGroups: parsePimGroups(opts.pimGroup),
    }),
  );

  printWorkspaceSummary(pod);

  if (!opts.attach) {
    console.log();
    console.log(chalk.dim(`Enter the container:  ap attach ${pod.id.slice(0, 8)}`));
    console.log(
      chalk.dim(`Hand off to worker:   ap run ${profile} <task> --base-branch ${pod.branch}`),
    );
    return;
  }

  const runningPod = await withSpinner(
    `Waiting for workspace ${pod.id.slice(0, 8)} to start...`,
    () => waitForPodRunning(client, pod, opts.timeout ?? DEFAULT_ATTACH_TIMEOUT_MS, deps),
  );

  await attachToRunningPod(client, runningPod, deps.attachSession);
}

function printWorkspaceSummary(pod: Pod): void {
  console.log(chalk.green(`Workspace ${chalk.bold(pod.id)} created.`));
  console.log(`${chalk.bold('Profile:')}  ${pod.profileName}`);
  console.log(`${chalk.bold('Status:')}   ${formatStatus(pod.status)}`);
  console.log(`${chalk.bold('Branch:')}   ${pod.branch}`);
}

async function waitForPodRunning(
  client: AutopodClient,
  initialPod: Pod,
  timeoutMs: number,
  deps: ResolvedWorkspaceCommandDeps,
): Promise<Pod> {
  let pod = initialPod;
  const deadline = deps.now() + timeoutMs;

  while (pod.status !== 'running') {
    if (TERMINAL_STATUSES.has(pod.status)) {
      throw new Error(
        `Pod ${pod.id.slice(0, 8)} reached ${pod.status} before it became attachable.`,
      );
    }

    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Pod ${pod.id.slice(0, 8)} is still ${pod.status} after ${Math.ceil(
          timeoutMs / 1000,
        )}s — container may have failed to start.`,
      );
    }

    await deps.sleep(Math.min(ATTACH_POLL_INTERVAL_MS, remainingMs));
    pod = await client.getSession(pod.id);
  }

  return pod;
}

function isInteractivePod(pod: Pod): boolean {
  return pod.options?.agentMode === 'interactive' || pod.outputMode === 'workspace';
}

async function attachToRunningPod(
  client: AutopodClient,
  pod: Pod,
  attachSession: AttachSessionRunner,
): Promise<void> {
  if (!isInteractivePod(pod)) {
    console.error(chalk.red(`Pod ${pod.id} is not an interactive pod.`));
    process.exit(1);
  }

  if (pod.status !== 'running') {
    console.error(chalk.red(`Pod ${pod.id} is ${pod.status} — can only attach to running pods.`));
    process.exit(1);
  }

  const containerName = `autopod-${pod.id}`;
  console.log(chalk.dim(`Attaching to ${containerName}…`));
  console.log(chalk.dim('Type "exit" to detach. Run "ap complete <id>" when done.\n'));

  const exitCode = await attachSession(containerName);

  console.log();

  // Non-zero exit may mean the container stopped unexpectedly
  if (exitCode !== 0) {
    try {
      const refreshed = await client.getSession(pod.id);
      if (refreshed.status !== 'running') {
        console.log(chalk.yellow('Container stopped unexpectedly.'));
        console.log(
          chalk.dim(`Run "ap complete ${pod.id.slice(0, 8)}" to recover changes and push branch.`),
        );
        return;
      }
    } catch {
      // Couldn't refresh — fall through to normal detach message
    }
  }

  console.log(chalk.dim('Detached. Pod is still running.'));
  console.log(chalk.dim(`Re-attach:  ap attach ${pod.id.slice(0, 8)}`));
  console.log(chalk.dim(`Complete:   ap complete ${pod.id.slice(0, 8)}`));
}

async function ensureSpawnHelperExecutable(): Promise<void> {
  try {
    const { createRequire } = await import('node:module');
    const { stat, chmod } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const req = createRequire(import.meta.url);
    const ptyMain = req.resolve('node-pty');
    const platform = `${process.platform}-${process.arch}`;
    const helperPath = join(dirname(dirname(ptyMain)), 'prebuilds', platform, 'spawn-helper');
    const s = await stat(helperPath);
    if (!(s.mode & 0o111)) {
      await chmod(helperPath, s.mode | 0o111);
    }
  } catch {
    // best-effort — node-pty will throw its own error if it still can't exec
  }
}

async function runAttachSession(containerName: string): Promise<number> {
  await ensureSpawnHelperExecutable();
  const { spawn: ptySpawn } = await import('node-pty');

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const ptyProcess = ptySpawn('docker', ['exec', '-it', containerName, '/bin/bash', '-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    env: process.env as Record<string, string>,
  });

  // Enable bracketed paste mode on the outer terminal
  process.stdout.write('\x1b[?2004h');

  ptyProcess.onData((data) => {
    process.stdout.write(data);
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();

  let pasteState: 'normal' | 'in-paste' = 'normal';
  let pasteBuffer = '';

  const onData = async (chunk: Buffer) => {
    const str = chunk.toString('binary');

    if (process.env.AUTOPOD_ATTACH_DEBUG === '1') {
      const preview = chunk.subarray(0, 64).toString('hex');
      attachDebug(`stdin chunk len=${chunk.length} state=${pasteState} hex=${preview}`);
    }

    if (pasteState === 'normal' && str.includes('\x1b[200~')) {
      pasteState = 'in-paste';
      const after = str.split('\x1b[200~')[1] ?? '';
      if (after.includes('\x1b[201~')) {
        // Start and end in the same chunk
        const content = after.split('\x1b[201~')[0] ?? '';
        pasteState = 'normal';
        await handleImagePaste(content, containerName, ptyProcess);
      } else {
        pasteBuffer = after;
      }
      return;
    }

    if (pasteState === 'in-paste') {
      if (str.includes('\x1b[201~')) {
        pasteBuffer += str.split('\x1b[201~')[0] ?? '';
        pasteState = 'normal';
        const content = pasteBuffer;
        pasteBuffer = '';
        await handleImagePaste(content, containerName, ptyProcess);
      } else {
        pasteBuffer += str;
      }
      return;
    }

    ptyProcess.write(str);
  };

  process.stdin.on('data', onData);

  const onResize = () => {
    ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  };
  process.stdout.on('resize', onResize);

  return new Promise<number>((resolve) => {
    ptyProcess.onExit(({ exitCode }) => {
      process.stdin.setRawMode(false);
      process.stdout.write('\x1b[?2004l');
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      resolve(exitCode ?? 0);
    });
  });
}

type PasteClassification =
  | { kind: 'empty-paste' }
  | { kind: 'host-image-path'; hostPath: string; ext: string }
  | { kind: 'text' };

async function classifyPaste(content: string): Promise<PasteClassification> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { kind: 'empty-paste' };
  }

  // cmux (and some other terminals) paste an image by writing its host-side
  // tempfile path into the PTY, optionally prefixed with `@`. Detect that case
  // so we can copy the file into the container instead of letting Claude Code
  // try to open a path that doesn't exist in its filesystem.
  let candidate = trimmed;
  if (candidate.startsWith('@')) candidate = candidate.slice(1).trim();

  if (!candidate.startsWith('/')) return { kind: 'text' };
  // Reject anything with whitespace or newlines in the middle — not a single path.
  if (/\s/.test(candidate)) return { kind: 'text' };

  const ext = extname(candidate).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return { kind: 'text' };

  try {
    const s = await stat(candidate);
    if (!s.isFile()) return { kind: 'text' };
  } catch {
    return { kind: 'text' };
  }

  return { kind: 'host-image-path', hostPath: candidate, ext: ext.slice(1) };
}

async function copyHostFileToContainer(
  hostPath: string,
  containerName: string,
  destPath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cp = spawn('docker', ['cp', hostPath, `${containerName}:${destPath}`]);
    let stderr = '';
    cp.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    cp.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker cp exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
    cp.on('error', reject);
  });
}

async function handleImagePaste(
  content: string,
  containerName: string,
  ptyProcess: IPty,
): Promise<void> {
  const classification = await classifyPaste(content);
  attachDebug(`paste classified as ${classification.kind} (len=${content.length})`);

  if (classification.kind === 'text') {
    ptyProcess.write(content);
    return;
  }

  const ts = Date.now();

  if (classification.kind === 'host-image-path') {
    const destPath = `/tmp/paste_${ts}.${classification.ext}`;
    try {
      await copyHostFileToContainer(classification.hostPath, containerName, destPath);
    } catch (err) {
      // Copy failed — fall back to writing the original content so the user
      // isn't left with a silently-eaten keystroke.
      process.stderr.write(
        `\n[autopod] image copy failed (${err instanceof Error ? err.message : String(err)}); pasting path as text\n`,
      );
      ptyProcess.write(content);
      return;
    }
    ptyProcess.write(`@${destPath} `);
    process.stderr.write(`\n[autopod] attached image → ${destPath}\n`);
    return;
  }

  // empty-paste — read host clipboard directly. Covers terminals that do
  // deliver an empty bracketed paste on image Cmd+V.
  const hostTmp = `/tmp/autopod_paste_${ts}.png`;
  const destPath = `/tmp/paste_${ts}.png`;

  const saved = await saveClipboardImage(hostTmp);
  if (!saved) {
    ptyProcess.write('\x07'); // bell — nothing in clipboard
    return;
  }

  try {
    await copyHostFileToContainer(hostTmp, containerName, destPath);
  } catch (err) {
    process.stderr.write(
      `\n[autopod] image copy failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  } finally {
    unlink(hostTmp).catch(() => {});
  }

  ptyProcess.write(`@${destPath} `);
  process.stderr.write(`\n[autopod] attached image → ${destPath}\n`);
}
