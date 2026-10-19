import type { ContainerManager } from '../interfaces/index.js';
import type { ProvisioningCaptured } from './provisioning-ports.js';

type Captured = Pick<ProvisioningCaptured, 'logger'>;

export function createProvisioningToolInstallation(captured: Captured) {
  const { logger } = captured;

  // Download the gh CLI binary from GitHub releases. No apt, no GPG keys —
  // it's a single Go binary. Throws on failure.
  async function installGhBinary(
    cm: ContainerManager,
    containerId: string,
    podId: string,
  ): Promise<void> {
    logger.info({ podId, containerId }, 'Installing gh CLI from github.com/cli/cli/releases');
    const result = await cm.execInContainer(
      containerId,
      [
        'sh',
        '-c',
        [
          'ARCH=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")',
          'VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest' +
            " | node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).tag_name.slice(1)))\")",
          'curl -fsSL "https://github.com/cli/cli/releases/download/v${VERSION}/gh_${VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /tmp',
          'mv /tmp/gh_${VERSION}_linux_${ARCH}/bin/gh /usr/local/bin/gh',
          'chmod +x /usr/local/bin/gh',
        ].join(' && '),
      ],
      { timeout: 120_000, user: 'root' },
    );
    if (result.exitCode !== 0) {
      const detail = (result.stdout + result.stderr).slice(-300).trimStart();
      throw new Error(`gh binary install failed (exit ${result.exitCode}): ${detail}`);
    }
  }

  // Install az CLI via pip. Uses get-pip.py because Debian/Ubuntu strip ensurepip from python3
  // (you'd normally need apt-get install python3-pip, but apt is broken on ARM Noble).
  // Throws on failure.
  async function installAzViaPip(
    cm: ContainerManager,
    containerId: string,
    podId: string,
  ): Promise<void> {
    logger.info({ podId, containerId }, 'Installing az CLI via pip (bootstrap.pypa.io get-pip.py)');
    const result = await cm.execInContainer(
      containerId,
      [
        'sh',
        '-c',
        [
          // Bootstrap pip using get-pip.py — the canonical workaround when ensurepip is stripped
          'curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py',
          'python3 /tmp/get-pip.py --quiet --break-system-packages 2>&1',
          // Now install azure-cli
          'python3 -m pip install --quiet --break-system-packages azure-cli 2>&1',
        ].join(' && '),
      ],
      { timeout: 300_000, user: 'root' },
    );
    if (result.exitCode !== 0) {
      const detail = (result.stdout + result.stderr).slice(-300).trimStart();
      throw new Error(`pip install azure-cli failed (exit ${result.exitCode}): ${detail}`);
    }
  }

  return { installGhBinary, installAzViaPip };
}
