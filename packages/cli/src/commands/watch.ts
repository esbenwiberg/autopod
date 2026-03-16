import type { Command } from 'commander';
import chalk from 'chalk';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Open the TUI dashboard (requires @autopod/tui)')
    .option('--theme <theme>', 'Color theme (dark or light)', 'dark')
    .option('--refresh <ms>', 'Refresh interval in milliseconds', '2000')
    .action((_opts: { theme?: string; refresh?: string }) => {
      // M10 will provide the TUI implementation
      console.log(chalk.yellow('The TUI dashboard is not yet available.'));
      console.log(chalk.dim('It will be implemented in M10 (TUI Dashboard).'));
      console.log(chalk.dim('For now, use: ap ls --json | jq'));
      process.exit(0);
    });
}
