import { Command } from 'commander';
import { AutopodClient } from './api/client.js';
import { resolveAuthConfig } from './auth/auth-config.js';
import { getToken, initMsal } from './auth/token-manager.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerHistoryCommands } from './commands/history.js';
import { registerMobileCommands } from './commands/mobile.js';
import { registerPodCommands } from './commands/pod.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerResearchCommands } from './commands/research.js';
import { registerScheduleCommands } from './commands/schedule.js';
import { registerSeriesCommands } from './commands/series.js';
import { registerSpecCommands } from './commands/spec.js';
import { registerValidateCommands } from './commands/validate.js';
import { registerWatchCommands } from './commands/watch.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import * as configStore from './config/config-store.js';
import { handleError } from './utils/error-handler.js';

const program = new Command();

program
  .name('ap')
  .description('Autopod — Sandboxed AI coding pods with self-validation')
  .version('0.0.1');

// Initialize MSAL from env vars first, then persisted CLI config.
const authConfig = resolveAuthConfig(process.env, configStore.getAll());
if (authConfig) {
  initMsal(authConfig.clientId, authConfig.tenantId, authConfig.scopes);
}

// Lazy client factory — only creates client when a command actually needs it
function getClient(): AutopodClient {
  const daemonUrl = configStore.get('daemon');
  if (!daemonUrl) {
    console.error('No daemon configured. Run: ap connect <url>');
    process.exit(5);
  }
  return new AutopodClient({ baseUrl: daemonUrl, getToken });
}

// Register all commands
registerAuthCommands(program);
registerDaemonCommands(program);
registerProfileCommands(program, getClient);
registerPodCommands(program, getClient);
registerWorkspaceCommands(program, getClient);
registerResearchCommands(program, getClient);
registerHistoryCommands(program, getClient);
registerValidateCommands(program, getClient);
registerScheduleCommands(program, getClient);
registerSeriesCommands(program, getClient);
registerSpecCommands(program);
registerWatchCommands(program, getClient);
registerMobileCommands(program);

// Parse and handle errors
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    handleError(error);
  }
}

main().catch(handleError);
