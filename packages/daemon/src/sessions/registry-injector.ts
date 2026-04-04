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
      content: generateNuGetConfig(nugetRegistries, pat),
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
 * with any solution-level NuGet.config. No <clear /> is used — existing
 * package sources in the workspace config are preserved.
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

/**
 * Patch workspace NuGet.config files with credentials for ADO feeds.
 *
 * Many repos use `<clear />` in their NuGet.config which wipes user-level configs.
 * This function finds ADO package sources defined in workspace configs and injects
 * credentials via `dotnet nuget update source`, which modifies the config in-place.
 */
export async function patchWorkspaceNuGetCredentials(
  containerManager: ContainerManager,
  containerId: string,
  pat: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<void> {
  // Find NuGet.config files in the workspace (max depth 2 to avoid scanning node_modules etc.)
  const findResult = await containerManager.execInContainer(
    containerId,
    ['find', '/workspace', '-maxdepth', '2', '-iname', 'nuget.config'],
    { timeout: 10_000 },
  );
  const configPaths = findResult.stdout.trim().split('\n').filter(Boolean);
  if (configPaths.length === 0) return;

  for (const configPath of configPaths) {
    // List sources defined in this config
    const listResult = await containerManager.execInContainer(
      containerId,
      ['dotnet', 'nuget', 'list', 'source', '--configfile', configPath, '--format', 'short'],
      { timeout: 15_000 },
    );
    if (listResult.exitCode !== 0) continue;

    // Parse source lines: "E https://pkgs.dev.azure.com/..." format
    // Each line is like "E  https://..." or "  2.  sourcename [Enabled]"
    // The short format gives: "E https://url"
    const lines = listResult.stdout.split('\n').filter((l) => l.includes('pkgs.dev.azure.com'));
    if (lines.length === 0) continue;

    // Read the config file to find source names for ADO feeds
    const configContent = await containerManager.readFile(containerId, configPath);
    const sourcePattern =
      /<add\s+key="([^"]+)"\s+value="(https?:\/\/pkgs\.dev\.azure\.com\/[^"]+)"/g;
    let match: RegExpExecArray | null;
    const adoSources: { name: string; url: string }[] = [];

    while ((match = sourcePattern.exec(configContent)) !== null) {
      adoSources.push({ name: match[1]!, url: match[2]! });
    }

    for (const source of adoSources) {
      const updateResult = await containerManager.execInContainer(
        containerId,
        [
          'dotnet',
          'nuget',
          'update',
          'source',
          source.name,
          '--username',
          'autopod',
          '--password',
          pat,
          '--store-password-in-clear-text',
          '--configfile',
          configPath,
        ],
        { timeout: 15_000 },
      );
      if (updateResult.exitCode === 0) {
        logger.info(
          { configPath, source: source.name },
          'Patched NuGet.config with ADO feed credentials',
        );
      } else {
        logger.warn(
          { configPath, source: source.name, stderr: updateResult.stderr.slice(0, 300) },
          'Failed to patch NuGet.config with credentials',
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
