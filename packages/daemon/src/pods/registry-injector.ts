import type { PrivateRegistry } from '@autopod/shared';

import type { ContainerManager } from '../interfaces/container-manager.js';
import { withRuntimeTelemetryOptOutEnv } from '../runtime-env.js';

export interface RegistryFile {
  /** Absolute path inside the container */
  path: string;
  /** File content */
  content: string;
}

/**
 * Paths for user-level registry config files inside the container.
 * Writing to user-level (~/) is non-destructive: the workspace's own
 * .npmrc / NuGet.config is left untouched.
 *
 * - npm: ~/.npmrc  — project .npmrc takes precedence, but user-level adds
 *   scoped registry mappings + auth tokens without conflict.
 * - NuGet: ~/.nuget/NuGet/NuGet.Config — dotnet merges user-level config
 *   with solution-level config; no <clear /> so existing sources are kept.
 */
const CONTAINER_HOME = '/home/autopod';
export const NPM_RC_PATH = `${CONTAINER_HOME}/.npmrc`;
export const NUGET_CONFIG_PATH = `${CONTAINER_HOME}/.nuget/NuGet/NuGet.Config`;

/**
 * Generate container files (.npmrc and/or NuGet.config) for authenticating
 * against private Azure DevOps package feeds.
 *
 * Both files are written to user-level locations inside the container so the
 * workspace's own config files are never overwritten.
 *
 * Returns an empty array if there are no registries or no PAT.
 */
export function buildRegistryFiles(
  registries: PrivateRegistry[],
  pat: string | null,
): RegistryFile[] {
  if (registries.length === 0 || !pat) return [];

  const files: RegistryFile[] = [];

  const npmRegistries = registries.filter((r) => r.type === 'npm');
  const nugetRegistries = registries.filter((r) => r.type === 'nuget');

  if (npmRegistries.length > 0) {
    files.push({
      path: NPM_RC_PATH,
      content: generateNpmrc(npmRegistries, pat),
    });
  }

  if (nugetRegistries.length > 0) {
    files.push({
      path: NUGET_CONFIG_PATH,
      content: generateNuGetConfig(nugetRegistries),
    });
  }

  return files;
}

/**
 * Generate .npmrc content for Azure DevOps npm feeds.
 *
 * For scoped registries:
 *   @scope:registry=https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/
 *   //pkgs.dev.azure.com/org/_packaging/feed/npm/registry/:_authToken=${PAT}
 *   //pkgs.dev.azure.com/org/_packaging/feed/npm/registry/:always-auth=true
 *
 * For unscoped (default registry override):
 *   registry=https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/
 *   //pkgs.dev.azure.com/org/_packaging/feed/npm/registry/:_authToken=${PAT}
 *   //pkgs.dev.azure.com/org/_packaging/feed/npm/registry/:always-auth=true
 */
export function generateNpmrc(registries: PrivateRegistry[], pat: string): string {
  const lines: string[] = [];

  for (const reg of registries) {
    const url = ensureTrailingSlash(reg.url);
    const urlPath = extractUrlPath(url);

    if (reg.scope) {
      lines.push(`${reg.scope}:registry=${url}`);
    } else {
      lines.push(`registry=${url}`);
    }

    lines.push(`//${urlPath}:_authToken=${pat}`);
    lines.push(`//${urlPath}:always-auth=true`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a user-level NuGet.config for Azure DevOps NuGet feeds.
 *
 * Written to ~/.nuget/NuGet/NuGet.Config (user-level), which dotnet merges
 * with any solution-level NuGet.config.
 *
 * Uses <clear /> to remove the default nuget.org source so all package
 * resolution goes through the configured private feeds. ADO feeds should
 * have nuget.org configured as an upstream source to proxy public packages.
 *
 * Includes <packageSourceMapping> entries so private feed sources are used
 * for package resolution even when the workspace NuGet.config has strict
 * source mapping (e.g. mapping "*" to nuget.org only). Without this, NuGet
 * ignores our injected sources and agents may resort to writing cleartext
 * credentials into the workspace config.
 *
 * Sources only — no credentials. Authentication is handled by the Azure
 * Artifacts Credential Provider via the VSS_NUGET_EXTERNAL_FEED_ENDPOINTS
 * environment variable (set on the container).
 */
export function generateNuGetConfig(registries: PrivateRegistry[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<configuration>',
    '  <packageSources>',
    '    <clear />',
  ];

  for (const reg of registries) {
    const name = deriveFeedName(reg.url);
    lines.push(`    <add key="${escapeXml(name)}" value="${escapeXml(reg.url)}" />`);
  }

  lines.push('  </packageSources>');

  // Map all packages to each private feed so NuGet uses them even when the
  // workspace config has its own packageSourceMapping that doesn't include
  // our injected source names.
  lines.push('  <packageSourceMapping>');
  for (const reg of registries) {
    const name = deriveFeedName(reg.url);
    lines.push(`    <packageSource key="${escapeXml(name)}">`);
    lines.push('      <package pattern="*" />');
    lines.push('    </packageSource>');
  }
  lines.push('  </packageSourceMapping>');

  lines.push('</configuration>');
  lines.push('');

  return lines.join('\n');
}

const NUGET_SECRET_PATH = '/run/autopod/nuget-endpoints';
const AGENT_SHIM_PATH = '/run/autopod/agent-shim.sh';

/**
 * Build the NuGet credential payload and return it as a secret file entry
 * (written to 0400) rather than an environment variable. The exec shim reads
 * the file and exports VSS_NUGET_EXTERNAL_FEED_ENDPOINTS before the runtime
 * starts, so the PAT is never in the container's process env at rest.
 *
 * Returns null when there are no NuGet registries or no PAT.
 */
export function buildNuGetSecretFile(
  registries: PrivateRegistry[],
  pat: string | null,
): { path: string; content: string; envKey: string; envFileKey: string } | null {
  if (!pat) return null;
  const nugetRegs = registries.filter((r) => r.type === 'nuget');
  if (nugetRegs.length === 0) return null;

  const payload = {
    endpointCredentials: nugetRegs.map((r) => ({
      endpoint: r.url,
      username: 'VssSessionToken',
      password: pat,
    })),
  };

  return {
    path: NUGET_SECRET_PATH,
    content: JSON.stringify(payload),
    envKey: 'VSS_NUGET_EXTERNAL_FEED_ENDPOINTS',
    envFileKey: 'VSS_NUGET_EXTERNAL_FEED_ENDPOINTS_FILE',
  };
}

/**
 * Build the VSS_NUGET_EXTERNAL_FEED_ENDPOINTS build-arg value for Docker image
 * builds. Used only during `docker build` (pre-warm) where the env is cleared at
 * the end of the Dockerfile. Do NOT use this for pod exec env — use
 * buildNuGetSecretFile() instead which writes to a 0400 file.
 */
export function buildNuGetCredentialEnv(
  registries: PrivateRegistry[],
  pat: string | null,
): Record<string, string> {
  if (!pat) return {};
  const nugetRegs = registries.filter((r) => r.type === 'nuget');
  if (nugetRegs.length === 0) return {};

  const payload = {
    endpointCredentials: nugetRegs.map((r) => ({
      endpoint: r.url,
      username: 'VssSessionToken',
      password: pat,
    })),
  };

  return { VSS_NUGET_EXTERNAL_FEED_ENDPOINTS: JSON.stringify(payload) };
}

/**
 * Build the env map passed into validation phase execs (build/test/lint/sast).
 *
 * Merges three sources, with `buildEnv` winning on key collision so a profile
 * author's explicit override beats inferred credentials:
 *  1) Autopod's non-secret runtime/tool telemetry opt-outs
 *  2) NuGet credential file pointer (from `buildNuGetSecretFile`)
 *  3) `profile.buildEnv` — free-form user-supplied env (e.g.
 *     `NODE_OPTIONS=--max-old-space-size=4096` for memory-heavy production
 *     bundles).
 */
export function buildValidationExecEnv(
  registries: PrivateRegistry[],
  pat: string | null,
  buildEnv: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  const nugetSecret = buildNuGetSecretFile(registries, pat);
  const merged = withRuntimeTelemetryOptOutEnv({
    ...(nugetSecret ? { [nugetSecret.envFileKey]: nugetSecret.path } : {}),
    ...(buildEnv ?? {}),
  });
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function wrapValidationExecCommand(
  command: string,
  env: Record<string, string> | undefined,
): string[] {
  const hasSecretFileEnv = env ? Object.keys(env).some((key) => key.endsWith('_FILE')) : false;
  return hasSecretFileEnv ? ['sh', AGENT_SHIM_PATH, 'sh', '-c', command] : ['sh', '-c', command];
}

/**
 * Git pre-commit hook script that blocks commits containing hardcoded credentials.
 *
 * Catches ClearTextPassword, _authToken=<value>, and common PAT prefixes in
 * staged files. Designed to be written to /workspace/.git/hooks/pre-commit
 * inside containers as a last line of defense against credential leaks.
 */
export const CREDENTIAL_GUARD_HOOK = `#!/bin/sh
# Autopod credential guard — blocks commits with hardcoded secrets
# Patterns: NuGet ClearTextPassword, npm _authToken, Azure DevOps PATs

BLOCKED_PATTERNS='ClearTextPassword|_authToken=.{10,}|_password=.{10,}'

# Only scan staged changes (not the entire working tree)
MATCHES=$(git diff --cached --diff-filter=ACMR -U0 -- . | grep -iE "^\\\\+.*($BLOCKED_PATTERNS)" || true)

if [ -n "$MATCHES" ]; then
  echo ""
  echo "ERROR: Commit blocked — hardcoded credentials detected in staged changes:"
  echo ""
  echo "$MATCHES" | head -5
  echo ""
  echo "Package authentication is pre-configured via environment variables."
  echo "Do NOT add credentials to config files. If auth fails, use report_blocker."
  echo ""
  exit 1
fi
`;

/**
 * Ensure the Azure Artifacts Credential Provider is installed for NuGet auth.
 *
 * The base Docker images install it at build time, but the install can fail
 * silently (GitHub rate limits, network issues during image build). This
 * runtime check detects the gap and re-installs, so pods don't fail
 * hours later during validation with a cryptic 401.
 */
export async function ensureNuGetCredentialProvider(
  containerManager: ContainerManager,
  containerId: string,
): Promise<void> {
  const check = await containerManager.execInContainer(
    containerId,
    [
      'sh',
      '-c',
      'ls /home/autopod/.nuget/plugins/netcore/CredentialProvider.Microsoft/ 2>/dev/null',
    ],
    { timeout: 5_000 },
  );
  if (check.exitCode === 0 && check.stdout.trim().length > 0) return;

  // Credential provider missing — install it now
  const install = await containerManager.execInContainer(
    containerId,
    ['sh', '-c', 'curl -fsSL https://aka.ms/install-artifacts-credprovider.sh | bash 2>&1'],
    { timeout: 60_000 },
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `Failed to install Azure Artifacts Credential Provider: ${install.stderr.slice(0, 500)}`,
    );
  }
}

/**
 * Validate that registry config files written to the container are functional.
 * Runs early — right after writing — so we fail fast instead of discovering
 * broken configs hours later during validation.
 *
 * Throws if any check fails with a descriptive error.
 */
export async function validateRegistryFiles(
  containerManager: ContainerManager,
  containerId: string,
  registryFiles: RegistryFile[],
  extraEnv?: Record<string, string>,
): Promise<void> {
  const envOption = extraEnv ? { env: extraEnv } : {};
  for (const file of registryFiles) {
    if (file.path.endsWith('.npmrc')) {
      // Quick check: npm config parse
      const result = await containerManager.execInContainer(
        containerId,
        ['npm', 'config', 'list', '--location=project'],
        { cwd: '/workspace', timeout: 15_000, ...envOption },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Registry check failed: .npmrc is invalid — npm config list exited ${result.exitCode}`,
        );
      }
    }

    if (file.path.toLowerCase().endsWith('nuget.config')) {
      const options = { cwd: '/workspace', timeout: 30_000, ...envOption };
      const result = await containerManager.execInContainer(
        containerId,
        ['dotnet', 'nuget', 'list', 'source', '--configfile', file.path],
        options,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Registry check failed: ${file.path} is invalid — dotnet nuget list source exited ${result.exitCode}`,
        );
      }

      // package search is supported starting with SDK 8.0.2xx. Check the actual
      // image capability, without relying on a mutable image tag or version guess.
      const capability = await containerManager.execInContainer(
        containerId,
        ['dotnet', 'package', 'search', '--help'],
        options,
      );
      if (
        capability.exitCode !== 0 ||
        !['--configfile', '--take', '--format'].every((flag) => capability.stdout.includes(flag))
      ) {
        throw new Error(
          'Registry capability unavailable: dotnet package search requires SDK 8.0.2xx or later with --configfile, --take and --format support. Update the execution image before dispatch.',
        );
      }
      const authCheck = await containerManager.execInContainer(
        containerId,
        [
          'dotnet',
          'package',
          'search',
          '__autopod_auth_probe__',
          '--configfile',
          file.path,
          '--take',
          '1',
          '--format',
          'json',
        ],
        { ...options, timeout: 60_000 },
      );
      const output = `${authCheck.stdout}\n${authCheck.stderr}`;
      // Do not persist raw tool output: sources and credential providers may echo
      // secret material. NU1301 alone proves unavailability, not rejected credentials.
      if (/\b(?:401|403)\b/.test(output)) {
        throw new Error(
          'Registry auth failed: NuGet feed rejected credentials (401/403). Check the PAT and Packaging (Read) permission.',
        );
      }
      if (output.includes('NU1301')) {
        throw new Error(
          'Registry feed unavailable: NuGet could not load a configured source; authentication is unconfirmed. Check connectivity, source configuration and credential-provider health.',
        );
      }
      if (authCheck.exitCode !== 0) {
        throw new Error(
          `Registry auth probe failed: dotnet package search exited ${authCheck.exitCode}; inspect the execution environment without exposing credentials.`,
        );
      }
      let report: unknown;
      try {
        report = JSON.parse(authCheck.stdout);
      } catch {
        throw new Error('Registry probe incomplete: search did not return valid JSON evidence.');
      }
      if (
        !report ||
        typeof report !== 'object' ||
        !('problems' in report) ||
        !Array.isArray(report.problems) ||
        report.problems.length > 0 ||
        !('searchResult' in report) ||
        !Array.isArray(report.searchResult)
      ) {
        throw new Error(
          'Registry probe incomplete: one or more configured sources lack successful search evidence.',
        );
      }
    }
  }
}

/** Ensure URL ends with / (required for npm registry URLs) */
function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** Extract the path portion of a URL without protocol (for .npmrc auth lines) */
function extractUrlPath(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/**
 * Derive a stable, XML-safe feed name from a URL.
 * E.g. "https://pkgs.dev.azure.com/myorg/_packaging/shared-libs/nuget/v3/index.json"
 *   → "myorg-shared-libs"
 */
function deriveFeedName(url: string): string {
  // Try to extract org and feed from Azure DevOps URL pattern
  const match = url.match(/pkgs\.dev\.azure\.com\/([^/]+)(?:\/[^/]+)?\/_packaging\/([^/]+)/);
  let name: string;
  if (match) {
    name = `${match[1]}-${match[2]}`;
  } else {
    // Fallback: use hostname + last path segment
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const last = segments.at(-1) ?? 'feed';
      name = `${parsed.hostname}-${last}`;
    } catch {
      return 'private-feed';
    }
  }
  return sanitizeElementName(name);
}

/**
 * Sanitize a string for use as an XML element name.
 * Element names may only contain letters, digits, hyphens, underscores, and periods.
 * They cannot start with a digit, hyphen, or period.
 */
function sanitizeElementName(name: string): string {
  // Replace invalid characters with hyphens
  let safe = name.replace(/[^a-zA-Z0-9._-]/g, '-');
  // Collapse consecutive hyphens
  safe = safe.replace(/-{2,}/g, '-');
  // Strip leading/trailing hyphens
  safe = safe.replace(/^-+|-+$/g, '');
  // Element names cannot start with a digit, period, or hyphen — prefix with underscore
  if (!safe || /^[^a-zA-Z_]/.test(safe)) {
    safe = `_${safe}`;
  }
  return safe || 'private-feed';
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
