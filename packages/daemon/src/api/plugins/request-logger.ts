import type { FastifyInstance } from 'fastify';

const REDACTED = '[REDACTED]';

function isSensitiveQueryParam(name: string): boolean {
  const normalized = name.replace(/[._\-[\]]/g, '').toLowerCase();
  return (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized.includes('authorization') ||
    normalized.includes('bearer') ||
    normalized === 'auth' ||
    normalized === 'pat' ||
    normalized.endsWith('apikey') ||
    normalized === 'key'
  );
}

export function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, 'http://autopod.local');
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveQueryParam(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`.replaceAll(
      encodeURIComponent(REDACTED),
      REDACTED,
    );
  } catch {
    return rawUrl;
  }
}

export function requestLoggerPlugin(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply) => {
    const duration = reply.elapsedTime;
    request.log.info(
      {
        method: request.method,
        path: sanitizeRequestUrl(request.url),
        status: reply.statusCode,
        duration: Math.round(duration),
      },
      'request completed',
    );
  });
}
