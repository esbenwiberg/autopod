import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
// qrcode-terminal has no published types; ambient declaration in ../types/qrcode-terminal.d.ts.
import qrcode from 'qrcode-terminal';
import * as configStore from '../config/config-store.js';

function readDevToken(): string | null {
  try {
    return readFileSync(join(homedir(), '.autopod', 'dev-token'), 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Returns the laptop's tailnet DNS name (e.g. `mymac.tail1234.ts.net`), without
 * the trailing dot. Falls back to null when `tailscale` isn't on PATH or the
 * command fails (e.g. tailscaled not running).
 */
function readTailscaleHost(): string | null {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName?.trim();
    if (!dns) return null;
    return dns.endsWith('.') ? dns.slice(0, -1) : dns;
  } catch {
    return null;
  }
}

function resolveHost(override: string | undefined): string | null {
  if (override) return override;
  const cached = configStore.get('mobile')?.host;
  if (cached) return cached;
  const detected = readTailscaleHost();
  if (detected) {
    configStore.set('mobile', { host: detected });
    return detected;
  }
  return null;
}

export function registerMobileCommands(program: Command): void {
  const mobile = program.command('mobile').description('Phone control surface (PWA)');

  mobile
    .command('pair')
    .description('Print a QR code that pairs a phone with this laptop over Tailscale')
    .option('--host <name>', 'Tailnet hostname to use (skips auto-detect + cache)')
    .action((opts: { host?: string }) => {
      const token = readDevToken();
      if (!token) {
        console.error(chalk.red('No dev token at ~/.autopod/dev-token.'));
        console.error(
          chalk.dim(
            'Start the daemon with AUTOPOD_ALLOW_DEV_AUTH=1 once to generate it, then re-run this command.',
          ),
        );
        process.exit(1);
      }

      const host = resolveHost(opts.host);
      if (!host) {
        console.error(chalk.red('Could not determine Tailscale hostname.'));
        console.error(
          chalk.dim(
            "Either install/start Tailscale (`tailscale status`) or pass --host <name>. The hostname looks like `mymac.tail1234.ts.net` and shows up in `tailscale status` as the laptop's MagicDNS name.",
          ),
        );
        process.exit(1);
      }

      // Token goes in the URL fragment, not the query string — fragments are
      // never sent to servers, so neither Tailscale's reverse proxy logs nor
      // the daemon's request logger ever see the token in plaintext.
      const url = `https://${host}/mobile/#token=${token}`;

      console.log();
      qrcode.generate(url, { small: true });
      console.log();
      console.log(chalk.bold('Scan with your phone, or open this URL on the tailnet:'));
      console.log(`  ${chalk.cyan(url)}`);
      console.log();
      console.log(
        chalk.dim(
          'First time? Run `ap mobile serve-instructions` for the one-time tailscale serve setup.',
        ),
      );
    });

  mobile
    .command('serve-instructions')
    .description('Print the one-time `tailscale serve` setup to expose the daemon')
    .action(() => {
      const detected = readTailscaleHost();
      const hostExample = detected ?? '<your-tailnet-hostname>';

      console.log();
      console.log(
        chalk.bold('# 1. Expose the daemon over Tailscale Serve (HTTPS via tailnet cert)'),
      );
      console.log(chalk.cyan('tailscale serve --bg --https=443 http://127.0.0.1:3100'));
      console.log();
      console.log(chalk.bold('# 2. Verify from your phone (on the tailnet):'));
      console.log(chalk.dim(`#    open https://${hostExample}/health in mobile Safari`));
      console.log(chalk.dim('#    → expect {"status":"ok",...}'));
      console.log();
      console.log(chalk.bold('# 3. Then pair:'));
      console.log(chalk.cyan('ap mobile pair'));
      console.log();
    });
}
