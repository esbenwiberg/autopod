import type { PrivateRegistry } from '@autopod/shared';

import type { ContainerManager } from '../interfaces/container-manager.js';

export interface RegistryFile {
  /** Absolute path inside the container */
  path: string;
  /** File content */
  content: string;
}

/**
 * Generate container files (.npmrc and/or NuGet.config) for authenticating
 * against private Azure DevOps package feeds.
 *
 * Returns an empty array if there are no registries or no PAT.
 */
export function buildRegistryFiles(
  registries: PrivateRegistry[],
  pat: string | null,
  nugetConfigPath = '/workspace/nuget.config',
): RegistryFile[] {
  if (registries.length === 0 || !pat) return [];

  const files: RegistryFile[] = [];

  const npmRegistries = registries.filter((r) => r.type === 'npm');
  const nugetRegistries = registries.filter((r) => r.type === 'nuget');

  if (npmRegistries.length > 0) {
    files.push({
      path: '/workspace/.npmrc',
      content: generateNpmrc(npmRegistries, pat),
    });
  }

  if (nugetRegistries.length > 0) {
    files.push({
      path: nugetConfigPath,
      content: generateNuGetConfig(nugetRegistries, pat),
    });
  }

  return files;
}

/**
 * Detect the existing NuGet config file path in the container workspace.
 * .NET SDK searches case-insensitively, so we must match the repo's casing
 * to avoid creating a second file that causes confusion.
 *
 * Returns the detected path or the default lowercase path.
 */
export async function detectNuGetConfigPath(
  containerManager: ContainerManager,
  containerId: string,
): Promise<string> {
  try {
    // List files matching any NuGet.Config casing in the workspace root
    const result = await containerManager.execInContainer(
      containerId,
      ['sh', '-c', 'ls /workspace/[Nn][Uu][Gg][Ee][Tt].[Cc][Oo][Nn][Ff][Ii][Gg] 2>/dev/null'],
      { timeout: 5_000 },
    );
    const existing = result.stdout.trim().split('\n').filter(Boolean);
    if (existing.length > 0) {
      return existing[0]; // Match the existing casing
    }
  } catch {
    // Container probe failed — fall through to default
  }
  return '/workspace/nuget.config';
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
 * Generate NuGet.config for Azure DevOps NuGet feeds.
 *
 * Uses ClearTextPassword with PAT (standard for CI/container use).
 * The `packageSourceCredentials` section key must match the source name
 * exactly — we derive a stable name from the feed URL.
 */
export function generateNuGetConfig(registries: PrivateRegistry[], pat: string): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<configuration>',
    '  <packageSources>',
    '    <clear />',
    '    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />',
  ];

  for (const reg of registries) {
    const name = deriveFeedName(reg.url);
    lines.push(`    <add key="${escapeXml(name)}" value="${escapeXml(reg.url)}" />`);
  }

  lines.push('  </packageSources>');
  lines.push('  <packageSourceCredentials>');

  for (const reg of registries) {
    const name = deriveFeedName(reg.url);
    lines.push(`    <${name}>`);
    lines.push('      <add key="Username" value="autopod" />');
    lines.push(`      <add key="ClearTextPassword" value="${escapeXml(pat)}" />`);
    lines.push(`    </${name}>`);
  }

  lines.push('  </packageSourceCredentials>');
  lines.push('</configuration>');
  lines.push('');

  return lines.join('\n');
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
        ['sh', '-c', `npm config list --location=project 2>&1`],
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
