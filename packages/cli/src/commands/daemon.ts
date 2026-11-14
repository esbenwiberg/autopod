import type { DaemonHealthSummary } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import { AutopodClient } from '../api/client.js';
import { getToken } from '../auth/token-manager.js';
import * as configStore from '../config/config-store.js';
import { withSpinner } from '../output/spinner.js';

/** One-line Docker bridge capacity summary, or null when the daemon does not report it. */
export function formatNetworkCapacity(health: DaemonHealthSummary): string | null {
  const networks = health.docker?.networks;
  if (!networks) return null;
  if (!('severity' in networks)) return `Docker networks: ${chalk.yellow('unavailable')}`;
  const pods = networks.podNetworks;
  const pools = networks.addressPools;
  const severity =
    networks.severity === 'critical'
      ? chalk.red('CRITICAL')
      : networks.severity === 'warning'
        ? chalk.yellow('WARNING')
        : networks.severity === 'ok'
          ? chalk.green('ok')
          : chalk.yellow('unknown');
  const poolText =
    pools.capacity === null
      ? 'pool capacity unknown'
      : `${pools.used}/${pools.capacity} pool subnets used (${pools.source})`;
  const line =
    `Docker networks: ${severity}; ${pods.total} autopod ` +
    `(${pods.retained ?? '?'} retained, ${pods.attached} attached, ` +
    `${pods.reclaimable ?? '?'} reclaimable` +
    `${pods.releasable === undefined ? '' : `, ${pods.releasable ?? '?'} releasable`}); ${poolText}; ` +
    `headroom ${networks.reclaimableHeadroom ?? '?'}`;
  if (networks.severity !== 'critical' && networks.severity !== 'warning') return line;
  return `${line}\n  New local pods may fail with HOST_NETWORK_CAPACITY. Kill failed pods you no longer need, release superseded retained bridges (ap release-retained-networks), or enlarge Docker default-address-pools (docs/hosted-daemon-docker-networks.md).`;
}

export function registerDaemonCommands(program: Command): void {
  program
    .command('health')
    .description('Show daemon release, backup and Docker network readiness')
    .option('--json', 'Print machine-readable health evidence')
    .option('--url <url>', 'Inspect this daemon without changing the saved connection')
    .action(async (options: { json?: boolean; url?: string }) => {
      const daemonUrl = options.url ?? configStore.get('daemon');
      if (!daemonUrl) throw new Error('No daemon configured. Run: ap connect <url>');
      const health = await new AutopodClient({
        baseUrl: daemonUrl,
        getToken: async () => '',
      }).checkHealth('full');
      if (options.json) {
        console.log(JSON.stringify(health, null, 2));
        return;
      }
      console.log(`Daemon v${health.version}: ${health.status}`);
      console.log(
        `Release: ${health.release?.commitSha ?? 'unavailable'}${health.release?.dirty ? ' (modified source)' : ''}`,
      );
      console.log(
        `Backup: ${health.backup?.state ?? 'unavailable'}; latest ${health.backup?.lastCompletedAt ?? 'unverified'}`,
      );
      const networks = formatNetworkCapacity(health);
      if (networks) console.log(networks);
    });

  program
    .command('connect <url>')
    .description('Connect to a daemon instance')
    .action(async (url: string) => {
      // Validate URL format
      try {
        new URL(url);
      } catch {
        console.error(chalk.red(`Invalid URL: ${url}`));
        process.exit(1);
      }

      configStore.set('daemon', url);

      // Health is public. Missing login must not look like an unreachable daemon.
      const client = new AutopodClient({ baseUrl: url, getToken: async () => '' });
      try {
        const health = await withSpinner('Connecting to daemon...', () => client.checkHealth());
        console.log(chalk.green(`Connected to daemon v${health.version} at ${url}`));
      } catch {
        console.log(chalk.yellow(`Saved ${url} but daemon is not reachable.`));
        console.log(chalk.dim('The daemon may not be running yet.'));
      }
    });

  program
    .command('disconnect')
    .description('Remove daemon connection')
    .action(() => {
      configStore.set('daemon', undefined);
      console.log(chalk.dim('Disconnected.'));
    });

  program
    .command('stop')
    .description('Gracefully stop the daemon')
    .action(async () => {
      const daemonUrl = configStore.get('daemon');
      if (!daemonUrl) {
        console.error(chalk.red('No daemon configured. Run: ap connect <url>'));
        process.exit(1);
      }

      const client = new AutopodClient({ baseUrl: daemonUrl, getToken });
      try {
        await withSpinner('Stopping daemon...', () => client.stopDaemon());
        console.log(chalk.green('Daemon is shutting down.'));
      } catch {
        console.error(chalk.red('Failed to reach daemon — it may already be stopped.'));
        process.exit(1);
      }
    });

  program
    .command('release-retained-networks')
    .description(
      'Release empty Docker bridges of superseded retained checkpoints (dry run unless --apply)',
    )
    .option('--dry-run', 'Show what would be released without changing anything (default)')
    .option('--apply', 'Record and remove eligible bridges; containers and source are untouched')
    .option('--limit <n>', 'Release at most N bridges, oldest first', (value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
        throw new Error('--limit must be an integer from 1 to 100');
      return parsed;
    })
    .option('--json', 'Print the machine-readable plan or report')
    .action(
      async (options: { dryRun?: boolean; apply?: boolean; limit?: number; json?: boolean }) => {
        if (options.dryRun && options.apply) throw new Error('Choose either --dry-run or --apply');
        const daemonUrl = configStore.get('daemon');
        if (!daemonUrl) throw new Error('No daemon configured. Run: ap connect <url>');
        const client = new AutopodClient({ baseUrl: daemonUrl, getToken });
        if (!options.apply) {
          const plan = await client.planRetainedNetworkRelease();
          if (options.json) {
            console.log(JSON.stringify(plan, null, 2));
            return;
          }
          console.log(
            `${chalk.cyan('Dry run')}: ${plan.eligible} of ${plan.candidates.length} retained bridges releasable`,
          );
          for (const c of plan.candidates)
            console.log(
              `  ${c.networkName}  ${c.eligible ? chalk.green('releasable') : chalk.dim(`held: ${c.reason ?? 'unknown'}`)}`,
            );
          if (plan.eligible > 0)
            console.log(chalk.dim('Review, then rerun with --apply to release them oldest first.'));
          return;
        }
        const report = await withSpinner('Releasing retained bridges...', () =>
          client.releaseRetainedNetworks(options.limit),
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`${chalk.green('Released')}: ${report.released} bridge(s)`);
        for (const r of report.results)
          console.log(
            `  ${r.networkName}  ${r.outcome === 'removed' || r.outcome === 'already_absent' ? chalk.green(r.outcome) : chalk.yellow(r.outcome)}${r.detail ? `  ${r.detail}` : ''}`,
          );
        if (report.results.some((r) => r.outcome === 'failed' || r.outcome === 'refused'))
          process.exitCode = 1;
      },
    );

  program
    .command('repair-token-telemetry')
    .description('Dry-run historical token telemetry repair (use --apply after review)')
    .option('--apply', 'Apply audited corrections instead of dry-run only')
    .option('--json', 'Print the complete machine-readable report')
    .action(async (options: { apply?: boolean; json?: boolean }) => {
      const daemonUrl = configStore.get('daemon');
      if (!daemonUrl) {
        console.error(chalk.red('No daemon configured. Run: ap connect <url>'));
        process.exitCode = 1;
        return;
      }
      const client = new AutopodClient({ baseUrl: daemonUrl, getToken });
      const report = await withSpinner(
        options.apply ? 'Applying telemetry repair...' : 'Scanning telemetry evidence...',
        () => client.repairTokenTelemetry(options.apply === true),
      );
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(
        `${options.apply ? chalk.green('Applied') : chalk.cyan('Dry run')}: ` +
          `${report.repairedPods} repairable, ${report.partialPods} partial, ` +
          `${report.skippedPods} skipped`,
      );
      for (const entry of report.entries) {
        const marker =
          entry.status === 'repaired'
            ? chalk.green('repaired')
            : entry.status === 'partial'
              ? chalk.yellow('partial')
              : chalk.dim('skipped');
        console.log(`  ${entry.podId}  ${marker}  ${entry.reason}`);
      }
      if (!options.apply && report.repairedPods > 0) {
        console.log(
          chalk.dim('Review this report, then rerun with --apply to persist corrections.'),
        );
      }
    });
}
