import { spawn as cpSpawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ActionOverride,
  PodOptions,
  Profile,
  PublicProfile,
  ValidationSuite,
} from '@autopod/shared';
import {
  ProfileNotFoundError,
  VALIDATION_SUITES,
  createProfileSchema,
  isValidationSuite,
  podOptionsFromOutputMode,
  updateProfileSchema,
} from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import { parse, stringify } from 'yaml';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { withSpinner } from '../output/spinner.js';
import { type ColumnDef, renderTable } from '../output/table.js';

const profileColumns: ColumnDef<Profile>[] = [
  { header: 'Name', key: 'name', width: 20 },
  { header: 'Template', key: 'template', width: 14 },
  { header: 'Repo', formatter: (p) => (p.repoUrl ?? '').replace(/^https?:\/\//, ''), width: 40 },
  { header: 'Model', key: 'defaultModel', width: 10 },
  { header: 'Runtime', key: 'defaultRuntime', width: 10 },
];

function parseValidationSuite(value: string): ValidationSuite {
  if (isValidationSuite(value)) return value;
  console.error(chalk.red(`suite must be one of: ${VALIDATION_SUITES.join(', ')}`));
  process.exit(1);
}

function defaultPodOptions(profile: Profile): PodOptions {
  return profile.pod ?? podOptionsFromOutputMode(profile.outputMode ?? 'pr');
}

export function registerProfileCommands(program: Command, getClient: () => AutopodClient): void {
  const profile = program.command('profile').description('Manage project profiles');

  profile
    .command('ls')
    .description('List all profiles')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const client = getClient();
      const profiles = await withSpinner('Fetching profiles...', () => client.listProfiles());

      withJsonOutput(opts, profiles, (data) => {
        if (data.length === 0) {
          console.log(chalk.dim('No profiles found. Create one with: ap profile create'));
          return;
        }
        console.log(renderTable(data, profileColumns));
      });
    });

  profile
    .command('show <name>')
    .description('Show profile details')
    .option('--json', 'Output as JSON')
    .action(async (name: string, opts: { json?: boolean }) => {
      const client = getClient();
      const p = await withSpinner('Fetching profile...', () => client.getProfile(name));

      withJsonOutput(opts, p, (data) => {
        console.log(chalk.bold.cyan(`Profile: ${data.name}`));
        console.log(chalk.dim('─'.repeat(40)));
        console.log(`${chalk.bold('Repo:')}       ${data.repoUrl}`);
        console.log(`${chalk.bold('Branch:')}     ${data.defaultBranch}`);
        console.log(`${chalk.bold('Template:')}   ${data.template}`);
        console.log(`${chalk.bold('Build:')}      ${data.buildCommand}`);
        console.log(`${chalk.bold('Setup:')}      ${data.validationSetupCommand}`);
        console.log(`${chalk.bold('Start:')}      ${data.startCommand}`);
        console.log(
          `${chalk.bold('Health:')}     ${data.healthPath} (${data.healthTimeout}s timeout)`,
        );
        console.log(`${chalk.bold('Model:')}      ${data.defaultModel}`);
        console.log(`${chalk.bold('Runtime:')}    ${data.defaultRuntime}`);
        console.log(`${chalk.bold('Max retries:')} ${data.maxValidationAttempts}`);
        const podOptions = defaultPodOptions(data);
        console.log(`${chalk.bold('Pod:')}        ${podOptions.agentMode} -> ${podOptions.output}`);
        console.log(
          `${chalk.bold('Suite:')}      ${podOptions.validationSuite ?? (podOptions.validate === false ? 'off' : 'full')}`,
        );
        if (data.agentDonePrompt) {
          console.log(`${chalk.bold('Done prompt:')} ${data.agentDonePrompt.length} chars`);
        }
        if (data.extends) {
          console.log(`${chalk.bold('Extends:')}    ${data.extends}`);
        }
        const patExpiries = [
          hasGithubPat(data) ? `GitHub ${data.githubPatExpiresAt ?? '(no expiry)'}` : null,
          hasAdoPat(data) ? `ADO ${data.adoPatExpiresAt ?? '(no expiry)'}` : null,
          hasRegistryPat(data) ? `Registry ${data.registryPatExpiresAt ?? '(no expiry)'}` : null,
        ].filter(Boolean);
        if (patExpiries.length > 0) {
          console.log(`${chalk.bold('PAT expiry:')} ${patExpiries.join(', ')}`);
        }
        if (data.smokePages.length > 0) {
          console.log(
            `${chalk.bold('Pages:')}      ${data.smokePages.map((p) => p.path).join(', ')}`,
          );
        }
        if (data.buildEnv && Object.keys(data.buildEnv).length > 0) {
          console.log(`${chalk.bold('Build env:')}`);
          for (const [k, v] of Object.entries(data.buildEnv).sort(([a], [b]) =>
            a.localeCompare(b),
          )) {
            console.log(`  ${chalk.cyan(k)}=${v}`);
          }
        }
        if (data.mcpServers && data.mcpServers.length > 0) {
          console.log(`${chalk.bold('MCP servers:')}`);
          for (const s of data.mcpServers) {
            const target = s.type === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url;
            console.log(
              `  ${chalk.cyan(s.name)} ${chalk.dim(target)}${s.description ? ` — ${s.description}` : ''}`,
            );
          }
        }
        if (data.claudeMdSections && data.claudeMdSections.length > 0) {
          console.log(`${chalk.bold('CLAUDE.md sections:')}`);
          for (const s of data.claudeMdSections) {
            const source = s.fetch ? chalk.dim('(dynamic)') : chalk.dim('(static)');
            console.log(`  ${chalk.cyan(s.heading)} ${source} priority=${s.priority ?? 50}`);
          }
        }
        if (data.warmImageTag) {
          console.log(
            `${chalk.bold('Warm image:')} ${data.warmImageTag} (${data.warmImageBuiltAt ?? 'unknown'})`,
          );
        }
        if (data.actionPolicy) {
          const { enabledGroups, actionOverrides } = data.actionPolicy;
          console.log(`${chalk.bold('Action groups:')} ${enabledGroups.join(', ')}`);
          if (actionOverrides && actionOverrides.length > 0) {
            console.log(chalk.bold('Action overrides:'));
            for (const o of actionOverrides) {
              const parts: string[] = [chalk.cyan(o.action)];
              if (o.disabled) parts.push(chalk.red('disabled'));
              if (o.requiresApproval) parts.push(chalk.yellow('requires-approval'));
              if (o.allowedResources && o.allowedResources.length > 0)
                parts.push(`repos: ${o.allowedResources.join(', ')}`);
              console.log(`  ${parts.join('  ')}`);
            }
          }
        }
      });
    });

  profile
    .command('create')
    .description('Create a new profile interactively via $EDITOR')
    .action(async () => {
      const client = getClient();
      const template = {
        name: 'my-project',
        // repoUrl: optional. Set to a github.com or dev.azure.com URL for repo-backed pods.
        // Leave null for ephemeral/red-team profiles or base profiles shared across repos.
        // buildCommand and startCommand are also optional when repoUrl is null.
        repoUrl: null,
        defaultBranch: 'main',
        template: 'node22',
        buildCommand: null,
        validationSetupCommand: null,
        startCommand: null,
        healthPath: '/',
        healthTimeout: 120,
        smokePages: [{ path: '/' }],
        maxValidationAttempts: 3,
        defaultModel: 'claude-opus-4-8',
        reviewerModel: 'claude-sonnet-4-6',
        defaultRuntime: 'claude',
        customInstructions: null,
        agentDonePrompt: null,
        escalation: {
          askHuman: true,
          askAi: {
            enabled: false,
            // Legacy wire compatibility; ask_ai and AI review use reviewerModel.
            model: 'claude-sonnet-4-6',
            maxCalls: 5,
          },
          advisor: { enabled: false },
          autoPauseAfter: 3,
          humanResponseTimeout: 3600,
        },
        mcpServers: [],
        claudeMdSections: [],
        extends: null,
        githubPatExpiresAt: null,
        adoPatExpiresAt: null,
        registryPatExpiresAt: null,
        actionPolicy: {
          enabledGroups: ['github-issues', 'github-prs'],
          // actionOverrides:
          //   - action: read_issue
          //     allowedResources:
          //       - myorg/*          # wildcard: all repos in myorg
          //       - myorg/backend    # exact repo
          //     requiresApproval: false
          //     disabled: false
        },
        pod: {
          agentMode: 'auto',
          output: 'pr',
          validationSuite: 'full',
        },
      };

      const edited = await openInEditor(template);
      if (!edited) {
        console.log(chalk.dim('Aborted.'));
        return;
      }

      const parsed = createProfileSchema.parse(edited) as Partial<Profile>;
      const created = await withSpinner('Creating profile...', () => client.createProfile(parsed));
      console.log(chalk.green(`Profile "${created.name}" created.`));
    });

  profile
    .command('edit <name>')
    .description('Edit a profile in $EDITOR')
    .action(async (name: string) => {
      const client = getClient();
      const existing = await client.getProfile(name);

      // Strip server-managed fields for editing
      const {
        createdAt: _c,
        updatedAt: _u,
        warmImageTag: _w,
        warmImageBuiltAt: _wb,
        hasGithubPat: _hgp,
        hasAdoPat: _hap,
        hasRegistryPat: _hrp,
        githubPat: _gp,
        adoPat: _ap,
        registryPat: _rp,
        ...editable
      } = existing;

      const edited = await openInEditor(editable);
      if (!edited) {
        console.log(chalk.dim('Aborted.'));
        return;
      }

      const updates = prepareProfileEditUpdates(edited as Record<string, unknown>);
      const parsed = updateProfileSchema.parse(updates) as Partial<Profile>;
      await withSpinner('Updating profile...', () => client.updateProfile(name, parsed));
      console.log(chalk.green(`Profile "${name}" updated.`));
    });

  profile
    .command('validation-suite <name> <suite>')
    .description(
      `Set the profile default Autopod validation suite (${VALIDATION_SUITES.join('|')})`,
    )
    .action(async (name: string, suiteRaw: string) => {
      const client = getClient();
      const suite = parseValidationSuite(suiteRaw);
      const existing = await withSpinner('Fetching profile...', () => client.getProfile(name));
      const pod: PodOptions = {
        ...defaultPodOptions(existing),
        validationSuite: suite,
        validate: suite !== 'off',
      };
      await withSpinner('Updating validation suite...', () => client.updateProfile(name, { pod }));
      console.log(chalk.green(`Profile "${name}" default validation suite: ${suite}.`));
    });

  profile
    .command('delete <name>')
    .description('Delete a profile')
    .option('-f, --force', 'Skip confirmation')
    .action(async (name: string, opts: { force?: boolean }) => {
      const client = getClient();

      if (!opts.force) {
        const confirmed = await confirm(`Delete profile "${name}"?`);
        if (!confirmed) {
          console.log(chalk.dim('Aborted.'));
          return;
        }
      }

      await withSpinner('Deleting profile...', () => client.deleteProfile(name));
      console.log(chalk.green(`Profile "${name}" deleted.`));
    });

  // ─── action-override subcommands ────────────────────────────────────────────

  const actionOverride = profile
    .command('action-override')
    .description('Manage per-action overrides (repo restrictions, approval requirements)');

  actionOverride
    .command('list <profile>')
    .description('List all action overrides for a profile')
    .option('--json', 'Output as JSON')
    .action(async (profileName: string, opts: { json?: boolean }) => {
      const client = getClient();
      const p = await withSpinner('Fetching profile...', () => client.getProfile(profileName));
      const overrides = p.actionPolicy?.actionOverrides ?? [];

      withJsonOutput(opts, overrides, (data) => {
        if (data.length === 0) {
          console.log(chalk.dim('No action overrides configured.'));
          console.log(
            chalk.dim(
              `Use: ap profile action-override set ${profileName} <action> --allow-repo <pattern>`,
            ),
          );
          return;
        }
        console.log(chalk.bold.cyan(`Action overrides for profile: ${profileName}`));
        console.log(chalk.dim('─'.repeat(60)));
        for (const o of data) {
          const flags: string[] = [];
          if (o.disabled) flags.push(chalk.red('disabled'));
          if (o.requiresApproval) flags.push(chalk.yellow('requires-approval'));
          const repos =
            o.allowedResources && o.allowedResources.length > 0
              ? chalk.dim(`repos: ${o.allowedResources.join(', ')}`)
              : chalk.dim('repos: (all)');
          console.log(
            `  ${chalk.cyan(o.action.padEnd(24))} ${repos}${flags.length > 0 ? `  ${flags.join(', ')}` : ''}`,
          );
        }
      });
    });

  actionOverride
    .command('set <profile> <action>')
    .description('Add or update an action override')
    .option(
      '--allow-repo <pattern>',
      'Allow action only for this repo/pattern (repeatable; use myorg/* for wildcard)',
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option('--require-approval', 'Require human approval before the action executes')
    .option('--no-require-approval', 'Remove human approval requirement')
    .option('--disable', 'Disable this action entirely')
    .option('--enable', 'Re-enable a previously disabled action')
    .action(
      async (
        profileName: string,
        actionName: string,
        opts: {
          allowRepo: string[];
          requireApproval?: boolean;
          disable?: boolean;
          enable?: boolean;
        },
      ) => {
        const client = getClient();
        const p = await withSpinner('Fetching profile...', () => client.getProfile(profileName));

        if (!p.actionPolicy) {
          console.error(
            chalk.red(
              `Profile "${profileName}" has no actionPolicy. Enable action groups first via: ap profile edit ${profileName}`,
            ),
          );
          process.exit(1);
        }

        const overrides: ActionOverride[] = [...(p.actionPolicy.actionOverrides ?? [])];
        const existing = overrides.find((o) => o.action === actionName);
        const override: ActionOverride = existing ?? { action: actionName };

        if (opts.allowRepo.length > 0) override.allowedResources = opts.allowRepo;
        if (opts.requireApproval === true) override.requiresApproval = true;
        if (opts.requireApproval === false) override.requiresApproval = false;
        if (opts.disable) override.disabled = true;
        if (opts.enable) override.disabled = false;

        if (!existing) {
          overrides.push(override);
        } else {
          const idx = overrides.indexOf(existing);
          overrides[idx] = override;
        }

        const currentPolicy = p.actionPolicy;
        await withSpinner('Saving override...', () =>
          client.updateProfile(profileName, {
            actionPolicy: { ...currentPolicy, actionOverrides: overrides },
          }),
        );

        console.log(chalk.green(`Override for "${actionName}" saved.`));
        if (override.allowedResources?.length)
          console.log(`  Repos: ${override.allowedResources.join(', ')}`);
        if (override.requiresApproval) console.log('  Requires human approval: yes');
        if (override.disabled) console.log(`  Status: ${chalk.red('disabled')}`);
      },
    );

  actionOverride
    .command('remove <profile> <action>')
    .description('Remove an action override entirely')
    .action(async (profileName: string, actionName: string) => {
      const client = getClient();
      const p = await withSpinner('Fetching profile...', () => client.getProfile(profileName));

      if (!p.actionPolicy?.actionOverrides?.length) {
        console.log(chalk.dim(`No overrides found for profile "${profileName}".`));
        return;
      }

      const filtered = p.actionPolicy.actionOverrides.filter((o) => o.action !== actionName);
      if (filtered.length === p.actionPolicy.actionOverrides.length) {
        console.log(chalk.dim(`No override found for action "${actionName}".`));
        return;
      }

      const policy = p.actionPolicy;
      await withSpinner('Removing override...', () =>
        client.updateProfile(profileName, {
          actionPolicy: { ...policy, actionOverrides: filtered },
        }),
      );
      console.log(chalk.green(`Override for "${actionName}" removed.`));
    });

  // ─── build-env subcommands ──────────────────────────────────────────────────

  profile
    .command('env-set <name> <pairs...>')
    .description(
      'Set build env vars (KEY=VALUE) injected into validation phase execs (build/test/lint/sast). ' +
        'Common: NODE_OPTIONS=--max-old-space-size=4096 for memory-heavy production bundles.',
    )
    .action(async (name: string, pairs: string[]) => {
      const client = getClient();
      const p = await withSpinner('Fetching profile...', () => client.getProfile(name));
      const env: Record<string, string> = { ...(p.buildEnv ?? {}) };
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq <= 0) {
          console.error(chalk.red(`Invalid KEY=VALUE pair: "${pair}"`));
          process.exit(1);
        }
        const k = pair.slice(0, eq);
        const v = pair.slice(eq + 1);
        env[k] = v;
      }
      await withSpinner('Saving build env...', () => client.updateProfile(name, { buildEnv: env }));
      console.log(chalk.green(`Updated build env for "${name}":`));
      for (const [k, v] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${chalk.cyan(k)}=${v}`);
      }
    });

  profile
    .command('env-unset <name> <keys...>')
    .description('Remove build env vars from a profile')
    .action(async (name: string, keys: string[]) => {
      const client = getClient();
      const p = await withSpinner('Fetching profile...', () => client.getProfile(name));
      const env: Record<string, string> = { ...(p.buildEnv ?? {}) };
      for (const k of keys) delete env[k];
      const next = Object.keys(env).length > 0 ? env : null;
      await withSpinner('Saving build env...', () =>
        client.updateProfile(name, { buildEnv: next }),
      );
      console.log(chalk.green(`Updated build env for "${name}".`));
    });

  // ────────────────────────────────────────────────────────────────────────────

  profile
    .command('auth-openai <name>')
    .description('Authenticate a profile with OpenAI Codex via ChatGPT/Pro login')
    .action(async (name: string) => {
      const client = getClient();

      try {
        await client.getProfile(name);
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          console.error(chalk.red(`Profile "${name}" not found.`));
        } else {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        }
        process.exit(1);
      }

      const token = Math.random().toString(36).slice(2, 10);
      const codexHome = path.join(os.tmpdir(), `autopod-codex-auth-${token}`);
      fs.mkdirSync(codexHome, { recursive: true });

      const spawnEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'OPENAI_API_KEY' && k !== 'CODEX_ACCESS_TOKEN') {
          spawnEnv[k] = v;
        }
      }
      spawnEnv.CODEX_HOME = codexHome;

      console.log(chalk.cyan(`\nStarting OpenAI Codex login for profile "${name}"...`));
      console.log(
        chalk.dim(
          'Follow the ChatGPT device/browser flow. Credentials will be saved automatically once complete.\n',
        ),
      );

      await new Promise<void>((resolve, reject) => {
        const proc = cpSpawn('codex', ['login', '--device-auth'], {
          stdio: 'inherit',
          env: spawnEnv,
        });
        proc.on('error', reject);
        proc.on('close', () => resolve());
      });

      const authPath = path.join(codexHome, 'auth.json');
      if (!fs.existsSync(authPath)) {
        console.error(chalk.red('\nNo Codex auth.json found — login may not have completed.'));
        process.exit(1);
      }

      let authJson: string;
      try {
        authJson = fs.readFileSync(authPath, 'utf-8');
        JSON.parse(authJson);
      } catch {
        console.error(chalk.red('\nFailed to parse Codex auth.json.'));
        process.exit(1);
      }

      await withSpinner(`Saving credentials for "${name}"...`, () =>
        client.setProfileCredentials(name, {
          defaultRuntime: 'codex',
          defaultModel: 'auto',
          modelProvider: 'openai',
          providerCredentials: {
            provider: 'openai',
            authMode: 'chatgpt',
            authJson,
          },
        }),
      );

      try {
        fs.rmSync(codexHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }

      console.log(chalk.green(`\nProfile "${name}" is now authenticated with OpenAI Codex.`));
    });

  profile
    .command('auth-copilot <name>')
    .description('Authenticate a profile with GitHub Copilot via interactive login')
    .action(async (name: string) => {
      const client = getClient();

      // Verify profile exists
      try {
        await client.getProfile(name);
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          console.error(chalk.red(`Profile "${name}" not found.`));
        } else {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        }
        process.exit(1);
      }

      // Isolated config dir so credentials land in a known place
      const token = Math.random().toString(36).slice(2, 10);
      const configDir = path.join(os.tmpdir(), `autopod-copilot-auth-${token}`);
      fs.mkdirSync(configDir, { recursive: true });

      // Build env: strip existing GitHub tokens so Copilot prompts a fresh login
      const spawnEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (
          v !== undefined &&
          k !== 'COPILOT_GITHUB_TOKEN' &&
          k !== 'GH_TOKEN' &&
          k !== 'GITHUB_TOKEN'
        ) {
          spawnEnv[k] = v;
        }
      }

      console.log(chalk.cyan(`\nStarting Copilot login for profile "${name}"...`));
      console.log(
        chalk.dim(
          'Follow the browser OAuth flow. Credentials will be saved automatically once complete.\n',
        ),
      );

      await new Promise<void>((resolve, reject) => {
        const proc = cpSpawn('copilot', ['login', '--config-dir', configDir], {
          stdio: 'inherit',
          env: spawnEnv,
        });
        proc.on('error', reject);
        proc.on('close', () => resolve());
      });

      // @github/copilot stores tokens as <config-dir>/github.com.tokens.json (file fallback)
      // or in the system keychain (macOS/Windows credential store) — try both
      let authToken: string | undefined;

      const credsPath = path.join(configDir, 'github.com.tokens.json');
      if (fs.existsSync(credsPath)) {
        try {
          const credsJson = JSON.parse(fs.readFileSync(credsPath, 'utf-8')) as Record<
            string,
            unknown
          >;
          authToken = typeof credsJson.token === 'string' ? credsJson.token : undefined;
        } catch {
          /* fall through to keychain */
        }
      }

      // macOS keychain fallback — security CLI will prompt for access if needed
      if (!authToken && process.platform === 'darwin') {
        try {
          authToken =
            execSync('security find-generic-password -s "copilot-cli" -w', {
              encoding: 'utf-8',
              stdio: ['inherit', 'pipe', 'inherit'],
            }).trim() || undefined;
        } catch {
          /* keychain read failed */
        }
      }

      if (!authToken) {
        console.error(chalk.red('\nNo token found — login may not have completed.'));
        process.exit(1);
      }

      await withSpinner(`Saving credentials for "${name}"...`, () =>
        client.setProfileCredentials(name, {
          modelProvider: 'copilot',
          providerCredentials: {
            provider: 'copilot',
            token: authToken,
          },
        }),
      );

      // Cleanup temp dir
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }

      console.log(chalk.green(`\nProfile "${name}" is now authenticated with GitHub Copilot.`));
    });

  profile
    .command('auth <name>')
    .description('Authenticate a profile with Claude MAX/PRO via interactive login')
    .action(async (name: string) => {
      const client = getClient();

      // Verify profile exists
      try {
        await client.getProfile(name);
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          console.error(chalk.red(`Profile "${name}" not found.`));
        } else {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        }
        process.exit(1);
      }

      // Isolated home so credentials land in a known place
      const token = Math.random().toString(36).slice(2, 10);
      const home = path.join(os.tmpdir(), `autopod-auth-${token}`);
      const claudeDir = path.join(home, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });

      // Suppress first-run prompts
      fs.writeFileSync(
        path.join(claudeDir, '.config.json'),
        JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
      );

      // Working dir (claude needs a git repo context)
      const cwd = path.join(os.tmpdir(), `autopod-auth-cwd-${token}`);
      fs.mkdirSync(cwd, { recursive: true });
      try {
        execSync('git init', { cwd, stdio: 'ignore' });
      } catch {
        /* best-effort */
      }

      // Build env: strip API key so Claude uses OAuth
      const spawnEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'ANTHROPIC_API_KEY') spawnEnv[k] = v;
      }
      spawnEnv.HOME = home;

      console.log(chalk.cyan(`\nStarting Claude login for profile "${name}"...`));
      console.log(
        chalk.dim(
          'Claude will open a browser URL. Complete the OAuth flow, then the credentials will be saved automatically.\n',
        ),
      );

      console.log(
        chalk.yellow(
          'When the Claude REPL opens, type /login and complete the OAuth flow, then exit with /exit.\n',
        ),
      );

      await new Promise<void>((resolve, reject) => {
        const proc = cpSpawn('claude', [], {
          stdio: 'inherit',
          env: spawnEnv,
          cwd,
        });
        proc.on('error', reject);
        proc.on('close', () => resolve());
      });

      // Read credentials from isolated home
      const credsPath = path.join(home, '.claude', '.credentials.json');
      if (!fs.existsSync(credsPath)) {
        console.error(chalk.red('\nNo credentials file found — login may not have completed.'));
        process.exit(1);
      }

      let creds: {
        claudeAiOauth?: {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: number;
          scopes?: string[];
          subscriptionType?: string;
          rateLimitTier?: string;
        };
      };
      try {
        creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      } catch {
        console.error(chalk.red('\nFailed to parse credentials file.'));
        process.exit(1);
      }

      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken || !oauth?.refreshToken) {
        console.error(chalk.red('\nCredentials file missing OAuth tokens.'));
        process.exit(1);
      }

      const expiresAt = oauth.expiresAt
        ? new Date(oauth.expiresAt).toISOString()
        : new Date(Date.now() + 3600_000).toISOString();

      await withSpinner(`Saving credentials for "${name}"...`, () =>
        client.setProfileCredentials(name, {
          modelProvider: 'max',
          providerCredentials: {
            provider: 'max',
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt,
            // Preserve all fields — claude 2.1.80+ requires scopes/subscriptionType
            ...(oauth.scopes && { scopes: oauth.scopes }),
            ...(oauth.subscriptionType && { subscriptionType: oauth.subscriptionType }),
            ...(oauth.rateLimitTier && { rateLimitTier: oauth.rateLimitTier }),
          },
        }),
      );

      // Cleanup temp dirs
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }

      console.log(chalk.green(`\nProfile "${name}" is now authenticated with Claude MAX/PRO.`));
    });

  profile
    .command('warm <name>')
    .description('Pre-build a warm Docker image for faster provisioning')
    .option('--rebuild', 'Force rebuild even if warm image exists')
    .action(async (name: string, opts: { rebuild?: boolean }) => {
      const client = getClient();
      await withSpinner(`Warming profile "${name}"...`, () =>
        client.warmProfile(name, opts.rebuild),
      );
      console.log(chalk.green(`Warm image for "${name}" is ready.`));
    });
}

type ProfileWithOptionalPresence = Profile &
  Partial<Pick<PublicProfile, 'hasGithubPat' | 'hasAdoPat' | 'hasRegistryPat'>>;

function hasGithubPat(profile: ProfileWithOptionalPresence): boolean {
  return profile.hasGithubPat ?? profile.githubPat !== null;
}

function hasAdoPat(profile: ProfileWithOptionalPresence): boolean {
  return profile.hasAdoPat ?? profile.adoPat !== null;
}

function hasRegistryPat(profile: ProfileWithOptionalPresence): boolean {
  return profile.hasRegistryPat ?? profile.registryPat !== null;
}

function prepareProfileEditUpdates(edited: Record<string, unknown>): Record<string, unknown> {
  const {
    name: _n,
    hasGithubPat: _hgp,
    hasAdoPat: _hap,
    hasRegistryPat: _hrp,
    ...updates
  } = edited;

  for (const field of ['githubPat', 'adoPat', 'registryPat'] as const) {
    if (typeof updates[field] !== 'string' || updates[field].length === 0) {
      delete updates[field];
    }
  }

  return updates;
}

async function openInEditor(data: unknown): Promise<unknown> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const tmpFile = path.join(os.tmpdir(), `autopod-profile-${Date.now()}.yaml`);

  const yamlContent = `# Edit this profile, then save and close the editor.\n# Lines starting with # are ignored.\n${stringify(data)}`;
  fs.writeFileSync(tmpFile, yamlContent, 'utf-8');

  try {
    execSync(`${editor} ${tmpFile}`, { stdio: 'inherit' });
    const edited = fs.readFileSync(tmpFile, 'utf-8');
    const parsed: unknown = parse(edited);
    return parsed;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // cleanup best-effort
    }
  }
}

function confirm(question: string): Promise<boolean> {
  const readline = require('node:readline') as typeof import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer: string) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}
