import type { FastifyRequest } from 'fastify';

const AUTH_PROTOCOL_PREFIX = 'autopod.bearer.';

function bearerFromAuthorizationHeader(header: string | undefined): string | null {
  const match = header?.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function bearerFromProtocolHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return null;

  const protocol = value
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.startsWith(AUTH_PROTOCOL_PREFIX));
  if (!protocol) return null;

  const encoded = protocol.slice(AUTH_PROTOCOL_PREFIX.length);
  if (!encoded) return null;

  try {
    return Buffer.from(encoded, 'base64url').toString('utf8') || null;
  } catch {
    return null;
  }
}

export function extractWebSocketBearerToken(request: FastifyRequest): string | null {
  return (
    bearerFromAuthorizationHeader(request.headers.authorization) ??
    bearerFromProtocolHeader(request.headers['sec-websocket-protocol'])
  );
}
