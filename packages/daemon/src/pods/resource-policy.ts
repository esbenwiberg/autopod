export const CONTAINER_APP_PORT = 3000;
export const PREVIEW_AUTO_STOP_MS = 10 * 60 * 1000;
export const CONTAINER_CLEANUP_TIMEOUT_MS = 15_000;
export const COMMIT_POLL_INTERVAL_MS = 60_000;
export function allocateHostPort(): number {
  return 10_000 + Math.floor(Math.random() * 39_000);
}
export function nativePreviewEmails(): string[] {
  return (process.env.AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS ?? '')
    .split(/[,\s]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}
export function parsePreviewPort(previewUrl: string): number | null {
  try {
    const parsed = new URL(previewUrl);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isSafeInteger(port) && port >= 0 ? port : null;
  } catch {
    return null;
  }
}
export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'host.docker.internal';
  }
}
export function portFromUrl(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3100;
  }
}
