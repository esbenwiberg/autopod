export class ManagedTransportError extends Error {
  constructor(readonly code: string) {
    super('managed-request-unavailable');
  }
}
export function managedErrorCode(error: unknown): string {
  if (error instanceof ManagedTransportError) return error.code;
  if (
    error instanceof Error &&
    [
      'managed-login-required',
      'managed-connection-mismatch',
      'managed-call-invalid',
      'managed-call-too-large',
      'managed-response-too-large',
    ].includes(error.message)
  )
    return error.message;
  return 'managed-request-unavailable';
}

export interface ManagedConnection {
  endpoint: string;
  issuer: string;
  audience: string;
  objectId: string;
}
export interface ManagedCall {
  method: string;
  path: string;
  body?: unknown;
  binary?: boolean;
  maximumBytes?: number;
}
export function validateManagedConnection(binding: ManagedConnection, configuredEndpoint: string) {
  const url = new URL(binding.endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    binding.endpoint.replace(/\/$/, '') !== configuredEndpoint.replace(/\/$/, '') ||
    !binding.issuer.startsWith('https://') ||
    !binding.audience ||
    !binding.objectId
  ) {
    throw new Error('managed-connection-mismatch');
  }
}
/** Decoding here only prevents sending another account's token. Server verifies signature/claims. */
export function validateManagedToken(token: string, binding: ManagedConnection) {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('managed-login-required');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (
    claims.iss !== binding.issuer ||
    claims.aud !== binding.audience ||
    claims.oid !== binding.objectId ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Date.now() / 1000
  )
    throw new Error('managed-login-required');
}

export async function managedRequest(
  binding: ManagedConnection,
  configuredEndpoint: string,
  token: string,
  call: ManagedCall,
  transport: typeof fetch = fetch,
): Promise<{ body?: unknown; base64?: string }> {
  validateManagedConnection(binding, configuredEndpoint);
  validateManagedToken(token, binding);
  const maximum = call.maximumBytes ?? 1024 * 1024;
  if (
    !['GET', 'POST'].includes(call.method) ||
    !/^\/(?:managed|artifacts)\/[A-Za-z0-9_/-]+(?:\?cursor=[0-9]+)?$/.test(call.path) ||
    call.path.split('/').some((part) => part === '.' || part === '..') ||
    !Number.isSafeInteger(maximum) ||
    maximum <= 0 ||
    maximum > (call.binary ? 64 * 1024 * 1024 : 1024 * 1024) ||
    (call.binary && call.method !== 'GET' && call.method !== 'POST')
  )
    throw new Error('managed-call-invalid');
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  if (body && Buffer.byteLength(body) > 1024 * 1024) throw new Error('managed-call-too-large');
  const response = await transport(binding.endpoint.replace(/\/$/, '') + call.path, {
    method: call.method,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ManagedTransportError(
      (
        {
          401: 'managed-http-unauthorized',
          403: 'managed-http-forbidden',
          404: 'managed-http-not-found',
          409: 'managed-http-conflict',
          429: 'managed-http-rate-limited',
        } as Record<number, string>
      )[response.status] ??
        (response.status >= 500 ? 'managed-http-server-error' : 'managed-http-rejected'),
    );
  }
  if (!response.body) throw new ManagedTransportError('managed-response-empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) throw new Error('managed-response-too-large');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (call.binary) return { base64: bytes.toString('base64') };
  if (!bytes.length) throw new ManagedTransportError('managed-response-empty');
  try {
    return { body: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new ManagedTransportError('managed-response-invalid');
  }
}
