import type {
  CompiledProvider,
  ProviderAccountProvider,
  ProviderCredentials,
  PublicProviderAccount,
  PublicProviderCatalog,
} from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { withSpinner } from '../output/spinner.js';
import { type ColumnDef, renderTable } from '../output/table.js';
import {
  extractClaudeOauthToken,
  isPiOAuthProviderId,
  runClaudeSetupToken,
  runCopilotLogin,
  runOpenAiCodexLogin,
  runPiLogin,
} from './provider-auth.js';

const accountColumns: ColumnDef<PublicProviderAccount>[] = [
  { header: 'ID', key: 'id', width: 24 },
  { header: 'Name', key: 'name', width: 24 },
  { header: 'Provider', key: 'provider', width: 12 },
  {
    header: 'Auth',
    formatter: (account) => (account.hasCredentials ? chalk.green('yes') : chalk.dim('no')),
    width: 8,
  },
  {
    header: 'Last Used',
    formatter: (account) => account.lastUsedAt ?? '-',
    width: 24,
  },
];

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function findCatalogProvider(
  catalog: PublicProviderCatalog,
  value: string,
): CompiledProvider | undefined {
  return catalog.providers.find((provider) => provider.id === value);
}

export function catalogProviderModels(
  catalog: PublicProviderCatalog,
  providerId: string,
): PublicProviderCatalog['models'] {
  return catalog.models.filter((model) => model.providerId === providerId);
}

export function canSubmitGenericApiKey(provider: CompiledProvider): boolean {
  return (
    provider.implementation.kind === 'generic-pi-api' &&
    provider.policy.authorization === 'supported' &&
    provider.policy.runnable &&
    provider.credentialOptions.some((option) => option.kind === 'api-key')
  );
}

async function requireCatalogProvider(
  client: AutopodClient,
  value: string,
): Promise<CompiledProvider> {
  const catalog = await client.getModelProviderCatalog();
  const provider = findCatalogProvider(catalog, value);
  if (!provider) {
    console.error(
      chalk.red(
        `provider must be one of: ${catalog.providers.map((candidate) => candidate.id).join(', ')}`,
      ),
    );
    process.exit(1);
  }
  return provider;
}

async function requireAccountProvider(
  client: AutopodClient,
  id: string,
  provider: ProviderAccountProvider,
): Promise<PublicProviderAccount> {
  const account = await client.getProviderAccount(id);
  if (account.provider !== provider) {
    console.error(
      chalk.red(
        `Provider account "${id}" is for ${account.provider}, not ${provider}. Create or choose a ${provider} account.`,
      ),
    );
    process.exit(1);
  }
  return account;
}

export function registerProviderAccountCommands(
  program: Command,
  getClient: () => AutopodClient,
): void {
  const accounts = program
    .command('provider-account')
    .alias('accounts')
    .description('Manage shared model-provider accounts');

  accounts
    .command('ls')
    .description('List provider accounts')
    .option('--provider <provider>', 'Filter by provider')
    .option('--json', 'Output as JSON')
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const client = getClient();
      const provider = opts.provider
        ? (await requireCatalogProvider(client, opts.provider)).id
        : undefined;
      const data = await withSpinner('Fetching provider accounts...', () =>
        client.listProviderAccounts(provider ? { provider } : undefined),
      );

      withJsonOutput(opts, data, (accountsData) => {
        if (accountsData.length === 0) {
          console.log(chalk.dim('No provider accounts found.'));
          return;
        }
        console.log(renderTable(accountsData, accountColumns));
      });
    });

  accounts
    .command('show <id>')
    .description('Show provider account details')
    .option('--json', 'Output as JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = getClient();
      const account = await withSpinner('Fetching provider account...', () =>
        client.getProviderAccount(id),
      );
      withJsonOutput(opts, account, (data) => {
        console.log(chalk.bold.cyan(`Provider account: ${data.name}`));
        console.log(chalk.dim('-'.repeat(40)));
        console.log(`${chalk.bold('ID:')}        ${data.id}`);
        console.log(`${chalk.bold('Provider:')}  ${data.provider}`);
        console.log(`${chalk.bold('Auth:')}      ${data.hasCredentials ? 'yes' : 'no'}`);
        console.log(`${chalk.bold('Created:')}   ${data.createdAt}`);
        console.log(`${chalk.bold('Updated:')}   ${data.updatedAt}`);
        if (data.lastAuthenticatedAt) {
          console.log(`${chalk.bold('Authed:')}    ${data.lastAuthenticatedAt}`);
        }
        if (data.lastUsedAt) {
          console.log(`${chalk.bold('Last used:')} ${data.lastUsedAt}`);
        }
      });
    });

  accounts
    .command('create <name>')
    .description('Create a shared provider account')
    .requiredOption('--provider <provider>', 'Provider for this account')
    .option('--id <id>', 'Stable lowercase account id')
    .option(
      '--link-profile <profile>',
      'Link a profile after creation; repeat for multiple profiles',
      collectOption,
      [] as string[],
    )
    .option(
      '--keep-legacy-credentials',
      'Keep linked profiles’ inline credentials (default: clear them on link)',
    )
    .option('--json', 'Output as JSON')
    .action(
      async (
        name: string,
        opts: {
          provider: string;
          id?: string;
          linkProfile: string[];
          keepLegacyCredentials?: boolean;
          json?: boolean;
        },
      ) => {
        const client = getClient();
        const catalogProvider = await requireCatalogProvider(client, opts.provider);
        const provider = catalogProvider.id;
        if (!catalogProvider.policy.runnable) {
          console.error(
            chalk.red(
              `${catalogProvider.displayName} cannot accept credentials: ${catalogProvider.policy.authorization}.`,
            ),
          );
          for (const caveat of catalogProvider.policy.caveats) {
            console.error(chalk.yellow(`${caveat.kind}: ${caveat.message}`));
          }
          process.exit(1);
        }
        const account = await withSpinner('Creating provider account...', () =>
          client.createProviderAccount({ name, id: opts.id, provider }),
        );

        for (const profileName of opts.linkProfile) {
          await withSpinner(`Linking ${profileName}...`, () =>
            client.linkProviderAccount(account.id, profileName, {
              clearLegacyCredentials: opts.keepLegacyCredentials ? false : undefined,
            }),
          );
        }

        withJsonOutput(opts, account, (data) => {
          console.log(chalk.green(`Provider account "${data.name}" created (${data.id}).`));
          if (opts.linkProfile.length > 0) {
            console.log(chalk.dim(`Linked profiles: ${opts.linkProfile.join(', ')}`));
          }
        });
      },
    );

  accounts
    .command('catalog')
    .description('List daemon-reviewed model providers and compatible models')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const catalog = await withSpinner('Fetching provider catalog...', () =>
        getClient().getModelProviderCatalog(),
      );
      withJsonOutput(opts, catalog, (data) => {
        for (const provider of data.providers) {
          const state = provider.policy.runnable
            ? chalk.green('runnable')
            : chalk.yellow(provider.policy.authorization);
          console.log(`${chalk.bold(provider.displayName)} (${provider.id}) — ${state}`);
          console.log(chalk.dim(provider.description));
          for (const credential of provider.credentialOptions) {
            console.log(`  ${credential.label}: ${credential.acquisition}`);
          }
          for (const model of catalogProviderModels(data, provider.id)) {
            console.log(`  ${model.displayName} (${model.id})`);
          }
          for (const caveat of provider.policy.caveats) {
            console.log(chalk.yellow(`  ${caveat.kind}: ${caveat.message}`));
          }
        }
      });
    });

  accounts
    .command('rename <id> <name>')
    .description('Rename a provider account')
    .action(async (id: string, name: string) => {
      const client = getClient();
      const account = await withSpinner('Renaming provider account...', () =>
        client.updateProviderAccount(id, { name }),
      );
      console.log(chalk.green(`Provider account "${account.id}" renamed to "${account.name}".`));
    });

  accounts
    .command('delete <id>')
    .description('Delete a provider account')
    .option('-f, --force', 'Skip confirmation')
    .action(async (id: string, opts: { force?: boolean }) => {
      const client = getClient();
      if (!opts.force) {
        const confirmed = await confirm(`Delete provider account "${id}"?`);
        if (!confirmed) {
          console.log(chalk.dim('Aborted.'));
          return;
        }
      }
      await withSpinner('Deleting provider account...', () => client.deleteProviderAccount(id));
      console.log(chalk.green(`Provider account "${id}" deleted.`));
    });

  accounts
    .command('link <id> <profile>')
    .description('Link a profile to a provider account')
    .option(
      '--keep-legacy-credentials',
      'Keep the profile’s inline credentials (default: clear them on link)',
    )
    .action(async (id: string, profileName: string, opts: { keepLegacyCredentials?: boolean }) => {
      const client = getClient();
      await withSpinner('Linking provider account...', () =>
        client.linkProviderAccount(id, profileName, {
          clearLegacyCredentials: opts.keepLegacyCredentials ? false : undefined,
        }),
      );
      console.log(chalk.green(`Profile "${profileName}" now uses provider account "${id}".`));
    });

  accounts
    .command('unlink <profile>')
    .description('Remove a profile provider-account link')
    .action(async (profileName: string) => {
      const client = getClient();
      await withSpinner('Unlinking provider account...', () =>
        client.unlinkProfileProviderAccount(profileName),
      );
      console.log(chalk.green(`Profile "${profileName}" no longer uses a provider account.`));
    });

  accounts
    .command('import <profile>')
    .description('Import legacy profile credentials into a provider account')
    .option('--id <id>', 'Existing or stable new account id')
    .option('--name <name>', 'Name for a new provider account')
    .option(
      '--link-profile <profile>',
      'Profile to link; repeat for multiple profiles. Defaults to the source profile.',
      collectOption,
      [] as string[],
    )
    .option(
      '--keep-legacy-credentials',
      'Keep the imported credentials on the owner profile (default: clear them)',
    )
    .option('--json', 'Output as JSON')
    .action(
      async (
        profileName: string,
        opts: {
          id?: string;
          name?: string;
          linkProfile: string[];
          keepLegacyCredentials?: boolean;
          json?: boolean;
        },
      ) => {
        const client = getClient();
        const result = await withSpinner('Importing provider credentials...', () =>
          client.importProviderAccountFromProfile({
            profileName,
            accountId: opts.id,
            accountName: opts.name,
            linkProfileNames: opts.linkProfile,
            clearLegacyCredentials: opts.keepLegacyCredentials ? false : undefined,
          }),
        );
        withJsonOutput(opts, result, (data) => {
          console.log(
            chalk.green(
              `Imported credentials into provider account "${data.account.name}" (${data.account.id}).`,
            ),
          );
          console.log(
            chalk.dim(`Linked profiles: ${data.linkedProfiles.map((p) => p.name).join(', ')}`),
          );
          if (data.legacyCredentialsCleared) {
            console.log(chalk.dim('Legacy profile credentials cleared.'));
          }
        });
      },
    );

  accounts
    .command('auth-api-key <id>')
    .description('Submit an API key for a runnable generic provider account')
    .action(async (id: string) => {
      const client = getClient();
      const account = await client.getProviderAccount(id);
      const provider = await requireCatalogProvider(client, account.provider);
      if (!canSubmitGenericApiKey(provider)) {
        console.error(
          chalk.red(
            `${provider.displayName} cannot accept an API key (${provider.policy.authorization}).`,
          ),
        );
        for (const caveat of provider.policy.caveats) {
          console.error(chalk.yellow(`${caveat.kind}: ${caveat.message}`));
        }
        process.exit(1);
      }
      const apiKey =
        process.env.AUTOPOD_PROVIDER_API_KEY?.trim() || (await readSecret('API key: '));
      if (!apiKey) {
        console.error(chalk.red('API key cannot be empty.'));
        process.exit(1);
      }
      const credentials = {
        provider: 'api-key',
        providerId: provider.id,
        apiKey,
      } satisfies ProviderCredentials;
      await withSpinner(`Saving credentials for "${id}"...`, () =>
        client.updateProviderAccount(id, { credentials }),
      );
      console.log(chalk.green(`Provider account "${id}" is authenticated.`));
    });

  accounts
    .command('auth-pi <id> <provider>')
    .description(
      'Authenticate a Pi provider account with a subscription provider (anthropic|openai-codex|github-copilot)',
    )
    .action(async (id: string, provider: string) => {
      if (!isPiOAuthProviderId(provider)) {
        console.error(
          chalk.red('provider must be one of: anthropic, openai-codex, github-copilot'),
        );
        process.exit(1);
      }

      const client = getClient();
      await requireAccountProvider(client, id, 'pi');
      console.log(chalk.cyan(`\nStarting Pi login for provider account "${id}" (${provider})...`));
      console.log(chalk.dim('Follow the Pi subscription login flow.\n'));
      let credentials: ProviderCredentials;
      try {
        credentials = await runPiLogin(provider);
      } catch (error) {
        console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
      await withSpinner(`Saving Pi credentials for "${id}"...`, () =>
        client.updateProviderAccount(id, { credentials }),
      );
      console.log(
        chalk.green(`\nProvider account "${id}" is authenticated with Pi (${provider}).`),
      );
    });

  accounts
    .command('auth-openai <id>')
    .description('Authenticate an OpenAI provider account with Codex ChatGPT/Pro login')
    .action(async (id: string) => {
      const client = getClient();
      await requireAccountProvider(client, id, 'openai');
      console.log(chalk.cyan(`\nStarting OpenAI Codex login for provider account "${id}"...`));
      console.log(chalk.dim('Follow the ChatGPT device/browser flow.\n'));
      const authJson = await runOpenAiCodexLogin();
      const credentials = {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson,
      } satisfies ProviderCredentials;
      await withSpinner(`Saving credentials for "${id}"...`, () =>
        client.updateProviderAccount(id, { credentials }),
      );
      console.log(chalk.green(`\nProvider account "${id}" is authenticated with OpenAI Codex.`));
    });

  accounts
    .command('auth-copilot <id>')
    .description('Authenticate a GitHub Copilot provider account')
    .action(async (id: string) => {
      const client = getClient();
      await requireAccountProvider(client, id, 'copilot');
      console.log(chalk.cyan(`\nStarting Copilot login for provider account "${id}"...`));
      console.log(chalk.dim('Follow the browser OAuth flow.\n'));
      const token = await runCopilotLogin();
      const credentials = { provider: 'copilot', token } satisfies ProviderCredentials;
      await withSpinner(`Saving credentials for "${id}"...`, () =>
        client.updateProviderAccount(id, { credentials }),
      );
      console.log(chalk.green(`\nProvider account "${id}" is authenticated with GitHub Copilot.`));
    });

  accounts
    .command('auth <id>')
    .description('Authenticate a Claude MAX/PRO provider account via setup-token')
    .action(async (id: string) => {
      const client = getClient();
      await requireAccountProvider(client, id, 'max');
      console.log(chalk.cyan(`\nStarting Claude setup-token for provider account "${id}"...`));
      console.log(chalk.dim('Complete the Claude subscription auth flow.\n'));
      const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
      const setupOutput = envToken ? '' : await runClaudeSetupToken();
      const oauthToken = envToken ?? extractClaudeOauthToken(setupOutput);
      if (!oauthToken) {
        console.error(
          chalk.red(
            '\nNo Claude setup token found. Run `claude setup-token`, then retry with CLAUDE_CODE_OAUTH_TOKEN set.',
          ),
        );
        process.exit(1);
      }
      const credentials = {
        provider: 'max',
        authMode: 'setup-token',
        oauthToken,
      } satisfies ProviderCredentials;
      await withSpinner(`Saving credentials for "${id}"...`, () =>
        client.updateProviderAccount(id, { credentials }),
      );
      console.log(chalk.green(`\nProvider account "${id}" is authenticated with Claude MAX/PRO.`));
    });
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

export interface SecretChunkResult {
  value: string;
  outcome?: 'submit' | 'cancel';
}

export function processSecretChunk(currentValue: string, chunk: string): SecretChunkResult {
  let value = currentValue;
  for (const character of chunk) {
    if (character === '\u0003') return { value, outcome: 'cancel' };
    if (character === '\r' || character === '\n') return { value, outcome: 'submit' };
    if (character === '\u007f' || character === '\b') {
      value = value.slice(0, -1);
    } else if (character >= ' ') {
      value += character;
    }
  }
  return { value };
}

function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(
      new Error('Interactive secret entry requires a TTY; set AUTOPOD_PROVIDER_API_KEY instead.'),
    );
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const restore = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      const result = processSecretChunk(value, chunk);
      value = result.value;
      if (result.outcome === 'cancel') {
        restore();
        reject(new Error('Secret entry cancelled.'));
      } else if (result.outcome === 'submit') {
        restore();
        resolve(value.trim());
      }
    };
    process.stdin.on('data', onData);
  });
}
