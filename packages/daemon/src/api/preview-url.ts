export interface PreviewUrlRewriteContext {
  requestHost?: string | string[];
  forwardedHost?: string | string[];
  forwardedProto?: string | string[];
  publicHost?: string;
  publicScheme?: string;
}

export function rewriteLoopbackPreviewUrl(
  previewUrl: string | null,
  context: PreviewUrlRewriteContext,
): string | null {
  if (!previewUrl) return previewUrl;

  let parsed: URL;
  try {
    parsed = new URL(previewUrl);
  } catch {
    return previewUrl;
  }

  if (!isLoopbackHost(parsed.hostname)) return previewUrl;

  const publicHost = resolvePublicPreviewHost(context);
  if (!publicHost) return previewUrl;

  const originalHadBareAuthority = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(previewUrl);
  parsed.hostname = publicHost;

  const publicScheme = normalizeScheme(context.publicScheme);
  if (publicScheme) {
    parsed.protocol = `${publicScheme}:`;
  }

  const rewritten = parsed.toString();
  return originalHadBareAuthority && rewritten.endsWith('/') ? rewritten.slice(0, -1) : rewritten;
}

export function resolvePublicPreviewHost(context: PreviewUrlRewriteContext): string | null {
  const authority = resolvePublicPreviewAuthority(context);
  if (!authority) return null;

  try {
    const url = new URL(`http://${authority}`);
    return url.hostname;
  } catch {
    return null;
  }
}

export function rewritePreviewUrlForBrowser(
  podId: string,
  previewUrl: string | null,
  context: PreviewUrlRewriteContext,
): string | null {
  if (!previewUrl) return previewUrl;

  let parsed: URL;
  try {
    parsed = new URL(previewUrl);
  } catch {
    return previewUrl;
  }

  if (!isLoopbackHost(parsed.hostname)) return previewUrl;

  const publicOrigin = resolvePublicPreviewOrigin(context);
  if (!publicOrigin) return previewUrl;

  return `${publicOrigin}/pods/${encodeURIComponent(podId)}/preview/proxy/`;
}

export function resolvePublicPreviewOrigin(context: PreviewUrlRewriteContext): string | null {
  const authority = resolvePublicPreviewAuthority(context);
  if (!authority) return null;

  const scheme =
    normalizeScheme(context.publicScheme) ??
    normalizeScheme(firstHeaderValue(context.forwardedProto) ?? undefined) ??
    'http';
  return `${scheme}://${authority}`;
}

export function resolvePublicPreviewAuthority(context: PreviewUrlRewriteContext): string | null {
  const candidate =
    firstHeaderValue(context.publicHost) ??
    firstHeaderValue(context.forwardedHost) ??
    firstHeaderValue(context.requestHost);
  if (!candidate) return null;

  const host = parseHostname(candidate);
  if (!host || isLoopbackHost(host)) return null;
  return parseAuthority(candidate);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (normalized === '0.0.0.0') return true;
  return normalized.startsWith('127.');
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(',')[0]?.trim();
  return first || null;
}

function parseHostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function parseAuthority(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return url.host || null;
  } catch {
    return null;
  }
}

function normalizeScheme(value: string | undefined): 'http' | 'https' | null {
  const scheme = value?.trim().toLowerCase().replace(/:$/, '');
  if (scheme === 'http' || scheme === 'https') return scheme;
  return null;
}
