import type { PrivateRegistry } from '@autopod/shared';

import type { ContainerManager } from '../interfaces/container-manager.js';

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
  lines.push('</configuration>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build the VSS_NUGET_EXTERNAL_FEED_ENDPOINTS environment variable value
 * for the Azure Artifacts Credential Provider.
 *
 * The credential provider intercepts NuGet auth challenges at the HTTP layer
 * and supplies credentials from this env var — no cleartext passwords in
 * config files.
 *
 * Returns an empty object when there are no NuGet registries.
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
      password: pat,
    })),
  };

  return { VSS_NUGET_EXTERNAL_FEED_ENDPOINTS: JSON.stringify(payload) };
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
): Promise<void> {
  for (const file of registryFiles) {
    if (file.path.endsWith('.npmrc')) {
      // Quick check: npm config parse
      const result = await containerManager.execInContainer(
        containerId,
        ['sh', '-c', 'npm config list --location=project 2>&1'],
        { cwd: '/workspace', timeout: 15_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Registry check failed: .npmrc is invalid — npm config list exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
        );
      }
    }

    if (file.path.toLowerCase().endsWith('nuget.config')) {
      // Check 1: XML is parseable (dotnet nuget list source reads the config)
      const result = await containerManager.execInContainer(
        containerId,
        ['sh', '-c', `dotnet nuget list source --configfile ${file.path} 2>&1`],
        { cwd: '/workspace', timeout: 30_000 },
      );
      if (result.exitCode !== 0) {
        const output = `${result.stdout}\n${result.stderr}`.trim();
        throw new Error(
          `Registry check failed: ${file.path} is invalid — dotnet nuget list source exited ${result.exitCode}: ${output.slice(0, 500)}`,
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
