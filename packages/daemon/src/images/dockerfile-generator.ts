import { createRequire } from 'node:module';
import type { PrivateRegistry, Profile, StackTemplate } from '@autopod/shared';

export interface DockerfileOptions {
  profile: Profile;
  gitCredentials: 'pat' | 'ssh' | 'none';
  /** Override image digests for tests. Production code loads from image-digests.json. */
  imageDigests?: Partial<Record<StackTemplate, string | null>>;
  /** Override Dagger CLI version config for tests. */
  daggerCliVersion?: DaggerCliVersion;
}

export interface DaggerCliVersion {
  version: string;
  linuxAmd64Digest: string;
}

const BASE_IMAGE_NAMES: Record<StackTemplate, string> = {
  node22: 'autopod-node22',
  'node22-pw': 'autopod-node22-pw',
  dotnet9: 'autopod-dotnet9',
  dotnet10: 'autopod-dotnet10',
  'dotnet10-go': 'autopod-dotnet10-go',
  python312: 'autopod-python312',
  'python-node': 'autopod-python-node',
  go124: 'autopod-go124',
  'go124-pw': 'autopod-go124-pw',
  custom: 'autopod-node22',
};

// Base images that ship with the Dagger CLI already installed in /usr/local/bin.
// Keep in sync with templates/base/Dockerfile.<template>.
const DAGGER_PREINSTALLED: ReadonlySet<StackTemplate> = new Set([
  'dotnet9',
  'dotnet10',
  'dotnet10-go',
  'go124',
  'go124-pw',
]);

// Load digests + Dagger version at module init. Graceful fallback for dev/test.
const _require = createRequire(import.meta.url);

function loadJsonConfig<T>(filename: string): T | null {
  try {
    return _require(`./${filename}`) as T;
  } catch {
    return null;
  }
}

const _imageDigestsConfig = loadJsonConfig<Record<string, string | null>>('image-digests.json');
const _daggerCliVersionConfig = loadJsonConfig<DaggerCliVersion>('dagger-cli-version.json');

export function generateDockerfile(options: DockerfileOptions): string {
  const { profile } = options;
  const digestMap = options.imageDigests ?? _imageDigestsConfig ?? {};
  const daggerVersion = options.daggerCliVersion ?? _daggerCliVersionConfig ?? null;
  const baseImage = getBaseImage(profile.template ?? 'node22', digestMap);
  const installCommand = getInstallCommand(profile);

  const lines: string[] = [
    `FROM ${baseImage}`,
    '',
    '# Clone repo and install dependencies',
    'WORKDIR /workspace',
  ];

  // Git credentials for private repos (repoUrl may be null for artifact-mode profiles)
  if (profile.repoUrl) {
    if (options.gitCredentials === 'pat') {
      lines.push(
        'ARG GIT_PAT',
        `RUN git clone --depth 1 https://x-access-token:\${GIT_PAT}@${stripProtocol(profile.repoUrl)} .`,
      );
    } else {
      lines.push(`RUN git clone --depth 1 ${profile.repoUrl} .`);
    }
  }

  // Inject private registry config for install step (uses build args, cleaned up below)
  const npmRegs = profile.privateRegistries.filter((r) => r.type === 'npm');
  const nugetRegs = profile.privateRegistries.filter((r) => r.type === 'nuget');
  if (npmRegs.length > 0) {
    lines.push('', 'ARG REGISTRY_PAT');
    lines.push(...generateNpmrcDockerLines(npmRegs));
  }
  if (nugetRegs.length > 0) {
    // NuGet auth via Azure Artifacts Credential Provider — credentials passed
    // as env var, never written to config files.
    lines.push(
      '',
      'ARG VSS_NUGET_EXTERNAL_FEED_ENDPOINTS',
      'ENV VSS_NUGET_EXTERNAL_FEED_ENDPOINTS=$VSS_NUGET_EXTERNAL_FEED_ENDPOINTS',
    );
    lines.push(...generateNuGetDockerLines(nugetRegs));
  }

  // Pre-warm dependency caches — best-effort. The auto-detected install command
  // can't always know the right working directory for monorepo-style projects
  // (e.g. dotnet at root + npm under `Client/`), and the project's actual
  // buildCommand re-runs the install at pod-start anyway. So a failure here is
  // a missed cache, not a runtime breakage. Critical installs (code-intel
  // tools below, agent CLIs) must NOT use `|| true` — those are runtime
  // requirements, not caches.
  lines.push('', '# Pre-warm dependency caches (best-effort)', `RUN ${installCommand} || true`);

  // Install agent CLIs so they're ready at container start (zero cold-start)
  lines.push(
    '',
    '# Install agent CLIs into the image',
    'RUN npm install -g @anthropic-ai/claude-code @openai/codex @github/copilot 2>/dev/null || true',
  );

  // Per-sidecar image mods: tools the pod needs to interact with a sidecar
  // must be present in the image (the pod can't install them at runtime under
  // a restricted network policy). Dagger sidecar → install the Dagger CLI,
  // unless the base image already ships it.
  const template = profile.template ?? 'node22';
  if (profile.sidecars?.dagger?.enabled && !DAGGER_PREINSTALLED.has(template)) {
    lines.push('', '# Dagger CLI — talks to the dagger-engine sidecar over TCP', 'USER root');
    if (daggerVersion && !daggerVersion.linuxAmd64Digest.includes('PLACEHOLDER')) {
      const { version, linuxAmd64Digest } = daggerVersion;
      const tarUrl = `https://github.com/dagger/dagger/releases/download/v${version}/dagger_v${version}_linux_amd64.tar.gz`;
      lines.push(
        'RUN set -eux; \\',
        `    curl -fsSL ${tarUrl} -o /tmp/dagger.tar.gz && \\`,
        `    echo "${linuxAmd64Digest}  /tmp/dagger.tar.gz" | sha256sum -c && \\`,
        '    tar -xz -C /usr/local/bin -f /tmp/dagger.tar.gz dagger && \\',
        '    rm /tmp/dagger.tar.gz',
      );
    } else {
      // Fallback: install script — use only until dagger-cli-version.json is populated
      lines.push(
        'RUN curl -fsSL https://dl.dagger.io/dagger/install.sh | BIN_DIR=/usr/local/bin sh',
      );
    }
    lines.push('USER autopod');
  }

  // Code intelligence tools (Serena + roslyn-codelens-mcp) — installed before pre-warm
  // so the tools are available from first container start with no cold-install penalty.
  // Installs run loud — if they fail, the build fails. Silent `|| true` is what
  // hid an entire feature from working for weeks.
  if (profile.codeIntelligence?.serena) {
    // Serena ships as the `serena-agent` PyPI package; the entry-point binary
    // is `serena`. Install via `uv` (per upstream docs) into the autopod user's
    // home so the runtime user can spawn it as a stdio MCP subprocess.
    // PATH is extended inline because subsequent RUN layers don't see the
    // updated ENV until after this block. Verify the binary by resolving its
    // path — invoking `--help` on MCP CLIs can SIGABRT if the binary expects
    // stdio rather than CLI args.
    lines.push(
      '',
      '# Serena — LSP-backed semantic code navigation (MCP stdio server)',
      'ENV PATH="/home/autopod/.local/bin:$PATH"',
      'RUN pip install --no-cache-dir --user uv \\',
      ' && uv tool install -p 3.13 serena-agent@latest --prerelease=allow \\',
      ' && command -v serena',
    );
  }
  if (profile.codeIntelligence?.roslynCodeLens) {
    // NuGet package id is `RoslynCodeLens.Mcp` (CamelCase); the resulting
    // binary is `roslyn-codelens-mcp` under ~/.dotnet/tools. Verify by file
    // existence rather than `--help` — the latter SIGABRTs because the binary
    // is an MCP stdio server and crashes when invoked without a JSON-RPC
    // stdin stream.
    lines.push(
      '',
      '# roslyn-codelens-mcp — Roslyn-backed DI / find-implementations (MCP stdio server)',
      'RUN dotnet tool install -g RoslynCodeLens.Mcp \\',
      ' && test -x /home/autopod/.dotnet/tools/roslyn-codelens-mcp',
      'ENV PATH="/home/autopod/.dotnet/tools:$PATH"',
    );
  }

  // Pre-warm build caches (buildCommand may be null on derived profiles that
  // only inherit; skip the pre-warm step in that case).
  if (profile.buildCommand) {
    const buildCmd = profile.buildWorkDir
      ? `cd /workspace/${profile.buildWorkDir} && ${profile.buildCommand}`
      : profile.buildCommand;
    lines.push(
      '',
      '# Pre-warm: run build to populate caches',
      '# || true because build may fail without code changes — we just want cached deps',
      `RUN ${buildCmd} || true`,
    );
  }

  // Clean up git credentials
  if (options.gitCredentials === 'pat') {
    lines.push(
      '',
      '# Remove git credentials from image',
      'RUN git remote set-url origin https://github.com/placeholder/repo.git',
    );
  }

  // Clean up registry config from image (pod provisioning re-injects at runtime)
  if (npmRegs.length > 0 || nugetRegs.length > 0) {
    const filesToRemove = [
      ...(npmRegs.length > 0 ? ['/workspace/.npmrc'] : []),
      ...(nugetRegs.length > 0 ? ['/workspace/NuGet.config'] : []),
    ].join(' ');
    lines.push(
      '',
      '# Remove registry config from image (re-injected at pod start)',
      `RUN rm -f ${filesToRemove}`,
    );
  }
  if (nugetRegs.length > 0) {
    lines.push(
      '# Clear credential provider env (no secrets in final image)',
      'ENV VSS_NUGET_EXTERNAL_FEED_ENDPOINTS=',
    );
  }

  // Set non-root user
  lines.push('', 'USER autopod');

  return lines.join('\n');
}

export function getBaseImage(
  template: StackTemplate,
  digestMap: Partial<Record<StackTemplate, string | null>> = {},
): string {
  const name = BASE_IMAGE_NAMES[template];
  const digest = digestMap[template];
  return digest ? `${name}@${digest}` : `${name}:latest`;
}

export function getInstallCommand(profile: Profile): string {
  // Fall back to an empty string when buildCommand is null (derived profile
  // that inherits); the install-command inference then falls back to npm ci.
  const cmd = profile.buildCommand ?? '';
  const isDotnet =
    profile.template === 'dotnet9' ||
    profile.template === 'dotnet10' ||
    profile.template === 'dotnet10-go';

  const isPythonNode = profile.template === 'python-node';
  if (isPythonNode) {
    const pip = 'pip install -r requirements.txt';
    if (cmd.includes('pnpm')) {
      return `${pip} && corepack enable pnpm && pnpm install --frozen-lockfile`;
    }
    if (cmd.includes('yarn')) {
      return `${pip} && corepack enable yarn && yarn install --frozen-lockfile`;
    }
    if (cmd.includes('npm')) {
      return `${pip} && npm ci`;
    }
    return pip;
  }

  const isGo = profile.template === 'go124' || profile.template === 'go124-pw';
  if (isGo) {
    // Mixed Go + JS: run go mod + JS install if build uses a Node pkg manager
    if (cmd.includes('pnpm')) {
      return 'go mod download && corepack enable pnpm && pnpm install --frozen-lockfile';
    }
    if (cmd.includes('yarn')) {
      return 'go mod download && corepack enable yarn && yarn install --frozen-lockfile';
    }
    if (cmd.includes('npm')) {
      return 'go mod download && npm ci';
    }
    return 'go mod download';
  }

  if (isDotnet) {
    // Mixed dotnet+npm: run both restores if the build command also invokes npm/pnpm/yarn
    if (cmd.includes('pnpm')) {
      return 'dotnet restore && corepack enable pnpm && pnpm install --frozen-lockfile';
    }
    if (cmd.includes('yarn')) {
      return 'dotnet restore && corepack enable yarn && yarn install --frozen-lockfile';
    }
    if (cmd.includes('npm')) {
      return 'dotnet restore && npm ci';
    }
    return 'dotnet restore';
  }
  if (cmd.includes('pnpm')) {
    return 'corepack enable pnpm && pnpm install --frozen-lockfile';
  }
  if (cmd.includes('yarn')) {
    return 'corepack enable yarn && yarn install --frozen-lockfile';
  }
  if (cmd.includes('pip')) {
    return 'pip install -r requirements.txt';
  }
  return 'npm ci';
}

function stripProtocol(url: string): string {
  // Drop scheme AND any embedded `user[:pass]@` userinfo. Azure DevOps repo
  // URLs commonly embed the org name as the username (e.g.
  // `https://365projectum@dev.azure.com/...`); leaving it in produces a
  // double-`@` URL when the Dockerfile prepends `x-access-token:${PAT}@`,
  // which git rejects with exit 128.
  return url.replace(/^https?:\/\//, '').replace(/^[^/@]+(?::[^/@]*)?@/, '');
}

/**
 * Generate Dockerfile RUN lines that write .npmrc with $REGISTRY_PAT expansion.
 * Uses echo + append so the build arg is expanded by the shell at build time.
 */
function generateNpmrcDockerLines(registries: PrivateRegistry[]): string[] {
  const echos: string[] = [];
  for (const reg of registries) {
    const url = reg.url.endsWith('/') ? reg.url : `${reg.url}/`;
    const urlPath = url.replace(/^https?:\/\//, '');
    const prefix = reg.scope ? `${reg.scope}:` : '';
    echos.push(`echo "${prefix}registry=${url}"`);
    echos.push(`echo "//${urlPath}:_authToken=$REGISTRY_PAT"`);
    echos.push(`echo "//${urlPath}:always-auth=true"`);
  }
  // First echo uses >, rest use >> to append
  const cmds = echos.map((e, i) => `${e} ${i === 0 ? '>' : '>>'} /workspace/.npmrc`);
  return [`RUN ${cmds.join(' && \\\n    ')}`];
}

/**
 * Generate Dockerfile RUN lines that write a sources-only NuGet.config.
 * No credentials — auth is handled by the Azure Artifacts Credential Provider
 * via VSS_NUGET_EXTERNAL_FEED_ENDPOINTS (set as a build arg / env var above).
 *
 * Includes packageSourceMapping so private feeds are used for package resolution
 * even when the workspace has strict source mapping.
 */
function generateNuGetDockerLines(registries: PrivateRegistry[]): string[] {
  const parts: string[] = [];
  parts.push('echo "<?xml version=\\"1.0\\" encoding=\\"utf-8\\"?>" > /workspace/NuGet.config');
  parts.push('echo "<configuration>" >> /workspace/NuGet.config');
  parts.push('echo "  <packageSources>" >> /workspace/NuGet.config');
  parts.push('echo "    <clear />" >> /workspace/NuGet.config');
  parts.push(
    'echo "    <add key=\\"nuget.org\\" value=\\"https://api.nuget.org/v3/index.json\\" />" >> /workspace/NuGet.config',
  );
  for (const reg of registries) {
    const name = deriveNuGetFeedName(reg.url);
    parts.push(
      `echo "    <add key=\\"${name}\\" value=\\"${reg.url}\\" />" >> /workspace/NuGet.config`,
    );
  }
  parts.push('echo "  </packageSources>" >> /workspace/NuGet.config');
  parts.push('echo "  <packageSourceMapping>" >> /workspace/NuGet.config');
  parts.push('echo "    <packageSource key=\\"nuget.org\\">" >> /workspace/NuGet.config');
  parts.push('echo "      <package pattern=\\"*\\" />" >> /workspace/NuGet.config');
  parts.push('echo "    </packageSource>" >> /workspace/NuGet.config');
  for (const reg of registries) {
    const name = deriveNuGetFeedName(reg.url);
    parts.push(`echo "    <packageSource key=\\"${name}\\">" >> /workspace/NuGet.config`);
    parts.push('echo "      <package pattern=\\"*\\" />" >> /workspace/NuGet.config');
    parts.push('echo "    </packageSource>" >> /workspace/NuGet.config');
  }
  parts.push('echo "  </packageSourceMapping>" >> /workspace/NuGet.config');
  parts.push('echo "</configuration>" >> /workspace/NuGet.config');

  return [`RUN ${parts.join(' && \\\n    ')}`];
}

/** Derive an XML-safe feed name from an Azure DevOps feed URL */
function deriveNuGetFeedName(url: string): string {
  const match = url.match(/pkgs\.dev\.azure\.com\/([^/]+)(?:\/[^/]+)?\/_packaging\/([^/]+)/);
  if (match) return `${match[1]}-${match[2]}`;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return `${parsed.hostname}-${segments.at(-1) ?? 'feed'}`.replace(/[^a-zA-Z0-9-]/g, '-');
  } catch {
    return 'private-feed';
  }
}
