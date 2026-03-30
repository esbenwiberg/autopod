import type { PrivateRegistry } from '@autopod/shared';

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
      path: '/workspace/NuGet.config',
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
    lines.push(`    <${escapeXml(name)}>`);
    lines.push('      <add key="Username" value="autopod" />');
    lines.push(`      <add key="ClearTextPassword" value="${escapeXml(pat)}" />`);
    lines.push(`    </${escapeXml(name)}>`);
  }

  lines.push('  </packageSourceCredentials>');
  lines.push('</configuration>');
  lines.push('');

  return lines.join('\n');
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
      name = `${parsed.hostname}-${last}`.replace(/[^a-zA-Z0-9-]/g, '-');
    } catch {
      return 'private-feed';
    }
  }
  // XML element names cannot start with a digit — prefix with underscore if needed
  return /^\d/.test(name) ? `_${name}` : name;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
