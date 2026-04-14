import { Command } from 'commander';
import { AutopodClient } from './api/client.js';
import { getToken, initMsal } from './auth/token-manager.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerHistoryCommands } from './commands/history.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerSessionCommands } from './commands/session.js';
import { registerValidateCommands } from './commands/validate.js';
import { registerWatchCommands } from './commands/watch.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import * as configStore from './config/config-store.js';
import { handleError } from './utils/error-handler.js';

const program = new Command();

program
  .name('ap')
  .description('Autopod — Sandboxed AI coding sessions with self-validation')
  .version('0.0.1');

// Initialize MSAL if env vars are set
const clientId = process.env.AUTOPOD_CLIENT_ID;
const tenantId = process.env.AUTOPOD_TENANT_ID;
if (clientId && tenantId) {
  initMsal(clientId, tenantId);
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
registerSessionCommands(program, getClient);
registerWorkspaceCommands(program, getClient);
registerHistoryCommands(program, getClient);
registerValidateCommands(program, getClient);
registerWatchCommands(program, getClient);

// Parse and handle errors
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    handleError(error);
  }
}

main().catch(handleError);
