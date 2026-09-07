import type { ActionDefinition, AuthConfig } from '@autopod/shared';
import { assertPublicUrl } from '../api/ssrf-guard.js';
import type { ActionHandler, HandlerConfig } from './handlers/handler.js';
import {
  fetchWithTimeout,
  pickFields,
  pickFieldsArray,
  readSafeJson,
  resolveResultPath,
  withAbort,
} from './handlers/handler.js';
import { createPinnedHttpTransport } from './pinned-http-transport.js';

export function createGenericHttpHandler(config: HandlerConfig): ActionHandler {
  const { logger, getSecret, ssrfGuard } = config;
  const log = logger.child({ handler: 'http' });
  const guard = ssrfGuard ?? ((url: string) => assertPublicUrl(url));
  const transport = config.httpTransport ?? createPinnedHttpTransport();

  function resolveSecret(ref: string): string {
    // Supports ${ENV_VAR} syntax
    const envMatch = ref.match(/^\$\{(.+)\}$/);
    if (envMatch?.[1]) {
      const value = getSecret(envMatch[1]);
      if (!value) throw new Error(`Secret not found: ${envMatch[1]}`);
      return value;
    }
    return ref;
  }

  function buildAuthHeaders(auth: AuthConfig | undefined): Record<string, string> {
    if (!auth || auth.type === 'none') return {};

    switch (auth.type) {
      case 'bearer':
        return { Authorization: `Bearer ${resolveSecret(auth.secret)}` };
      case 'basic':
        return {
          Authorization: `Basic ${Buffer.from(`${resolveSecret(auth.username)}:${resolveSecret(auth.password)}`).toString('base64')}`,
        };
      case 'custom-header':
        return { [auth.name]: resolveSecret(auth.value) };
    }
  }

  function applyTemplate(template: string, params: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = params[key];
      return value !== undefined && value !== null ? String(value) : '';
    });
  }

  function applyMappings(
    mapping: Record<string, string> | undefined,
    params: Record<string, unknown>,
  ): Record<string, string> {
    if (!mapping) return {};
    const result: Record<string, string> = {};
    for (const [key, template] of Object.entries(mapping)) {
      result[key] = applyTemplate(template, params);
    }
    return result;
  }

  return {
    handlerType: 'http',

    async execute(action: ActionDefinition, params: Record<string, unknown>): Promise<unknown> {
      if (!action.endpoint) {
        throw new Error(`HTTP action '${action.name}' missing endpoint configuration`);
      }

      const { url: rawUrl, method, auth, timeout: actionTimeout } = action.endpoint;

      // Apply path mappings to URL
      let url = applyTemplate(rawUrl, params);
      if (action.request?.pathMapping) {
        for (const [key, template] of Object.entries(action.request.pathMapping)) {
          url = url.replace(`{${key}}`, applyTemplate(template, params));
        }
      }

      // Build query string
      if (action.request?.queryMapping) {
        const queryParams = applyMappings(action.request.queryMapping, params);
        const qs = new URLSearchParams(queryParams).toString();
        url += (url.includes('?') ? '&' : '?') + qs;
      }

      // Build headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(auth),
      };

      // Build body
      let body: string | undefined;
      if (method === 'POST' || method === 'PUT') {
        if (action.request?.bodyMapping) {
          const mapped = applyMappings(action.request.bodyMapping, params);
          body = JSON.stringify(mapped);
        }
      }

      const response = await fetchWithTimeout(
        url,
        {
          method,
          headers,
          body,
          timeout: actionTimeout ?? 15_000,
        },
        async (destination, init) => {
          const signal = init.signal;
          if (!signal) throw new Error('Missing HTTP request deadline');
          const checked = await withAbort(guard(destination), signal);
          signal.throwIfAborted();
          if (!checked.ok) {
            log.warn({ action: action.name }, 'HTTP action blocked by destination policy');
            throw new Error(
              `HTTP action '${action.name}' blocked: ${checked.reason ?? 'private address'}`,
            );
          }
          if (!checked.resolvedIps?.length) throw new Error('Missing validated HTTP destination');
          log.debug({ action: action.name, method }, 'Executing HTTP action');
          return transport(destination, init, checked.resolvedIps);
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} from ${action.name}: ${text.slice(0, 200)}`);
      }

      const data = await readSafeJson(response);

      // Resolve result path (e.g. 'data.results')
      const resolved = resolveResultPath(data, action.response.resultPath);

      // Apply field whitelist
      if (Array.isArray(resolved)) {
        return pickFieldsArray(resolved, action.response.fields);
      }
      return pickFields(resolved, action.response.fields);
    },
  };
}
