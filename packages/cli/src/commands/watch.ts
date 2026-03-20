import type { Command } from 'commander';
import { getToken } from '../auth/token-manager.js';
import * as configStore from '../config/config-store.js';
import { renderDashboard } from '../tui/index.js';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .alias('dashboard')
    .description('Open the TUI dashboard')
    .action(async () => {
      const daemonUrl = configStore.get('daemon');
      if (!daemonUrl) {
        console.error('No daemon configured. Run: ap connect <url>');
        process.exit(5);
      }

      const token = await getToken();
      renderDashboard({ daemonUrl, token });
    });
}
