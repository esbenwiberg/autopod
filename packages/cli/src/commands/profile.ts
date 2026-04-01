import { spawn as cpSpawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Profile } from '@autopod/shared';
import { createProfileSchema, updateProfileSchema } from '@autopod/shared';
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
  { header: 'Repo', formatter: (p) => p.repoUrl.replace(/^https?:\/\//, ''), width: 40 },
  { header: 'Model', key: 'defaultModel', width: 10 },
  { header: 'Runtime', key: 'defaultRuntime', width: 10 },
];

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
        console.log(`${chalk.bold('Start:')}      ${data.startCommand}`);
        console.log(
          `${chalk.bold('Health:')}     ${data.healthPath} (${data.healthTimeout}s timeout)`,
        );
        console.log(`${chalk.bold('Model:')}      ${data.defaultModel}`);
        console.log(`${chalk.bold('Runtime:')}    ${data.defaultRuntime}`);
        console.log(`${chalk.bold('Max retries:')} ${data.maxValidationAttempts}`);
        if (data.extends) {
          console.log(`${chalk.bold('Extends:')}    ${data.extends}`);
        }
        if (data.smokePages.length > 0) {
          console.log(
            `${chalk.bold('Pages:')}      ${data.smokePages.map((p) => p.path).join(', ')}`,
          );
        }
        if (data.mcpServers && data.mcpServers.length > 0) {
          console.log(`${chalk.bold('MCP servers:')}`);
          for (const s of data.mcpServers) {
            console.log(
              `  ${chalk.cyan(s.name)} ${chalk.dim(s.url)}${s.description ? ` — ${s.description}` : ''}`,
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
      });
    });

  profile
    .command('create')
    .description('Create a new profile interactively via $EDITOR')
    .action(async () => {
      const client = getClient();
      const template = {
        name: 'my-project',
        repoUrl: 'https://github.com/org/repo',
        defaultBranch: 'main',
        template: 'node22',
        buildCommand: 'npm run build',
        startCommand: 'npm start',
        healthPath: '/',
        healthTimeout: 120,
        smokePages: [{ path: '/' }],
        maxValidationAttempts: 3,
        defaultModel: 'opus',
        defaultRuntime: 'claude',
        customInstructions: null,
        escalation: {
          askHuman: true,
          askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
          autoPauseAfter: 3,
          humanResponseTimeout: 3600,
        },
        mcpServers: [],
        claudeMdSections: [],
        extends: null,
      };

      const edited = await openInEditor(template);
      if (!edited) {
        console.log(chalk.dim('Aborted.'));
        return;
      }

      const parsed = createProfileSchema.parse(edited);
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
        ...editable
      } = existing;

      const edited = await openInEditor(editable);
      if (!edited) {
        console.log(chalk.dim('Aborted.'));
        return;
      }

      const { name: _n, ...updates } = edited as Record<string, unknown>;
      const parsed = updateProfileSchema.parse(updates);
      await withSpinner('Updating profile...', () => client.updateProfile(name, parsed));
      console.log(chalk.green(`Profile "${name}" updated.`));
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

  profile
    .command('auth-copilot <name>')
    .description('Authenticate a profile with GitHub Copilot via interactive login')
    .action(async (name: string) => {
      const client = getClient();

      // Verify profile exists
      try {
        await client.getProfile(name);
      } catch {
        console.error(chalk.red(`Profile "${name}" not found.`));
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
      } catch {
        console.error(chalk.red(`Profile "${name}" not found.`));
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
