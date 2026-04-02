import type { DataSanitizationConfig, SanitizationPreset } from '../types/actions.js';
import { PII_PATTERNS, REDACT_FIELD_NAMES } from './patterns.js';

const REDACTED_VALUE = '[REDACTED]';

/**
 * Sanitize a string by applying PII pattern matching.
 * Fail-open: if a regex throws, the text passes through unchanged.
 * The error is logged to stderr so it can be monitored and investigated.
 */
export function sanitize(text: string, config: DataSanitizationConfig): string {
  const preset = config.preset ?? 'standard';
  const allowedDomains = new Set(config.allowedDomains ?? []);

  let result = text;
  for (const pattern of PII_PATTERNS) {
    if (!pattern.presets.includes(preset)) continue;

    try {
      result = result.replace(pattern.regex, (match) => {
        // Check if the match is in an allowed domain (for email patterns)
        if (pattern.name === 'email' && allowedDomains.size > 0) {
          const domain = match.split('@')[1];
          if (domain && allowedDomains.has(domain)) return match;
        }
        return pattern.replacement;
      });
    } catch (err) {
      // Fail-open: regex error shouldn't block content, but log it so it can be monitored.
      // A silently skipped pattern means PII may pass through unredacted.
      // Use globalThis.console to avoid a lib: dom dependency in this zero-dep package.
      (globalThis as { console?: { error: (...a: unknown[]) => void } }).console?.error(
        `[autopod/sanitize] PII pattern '${pattern.name}' threw an error — content passed through unredacted:`,
        err,
      );
    }
  }

  return result;
}

/**
 * Deep-sanitize an object tree: walk all string values and apply PII sanitization.
 * Also redacts known sensitive field names entirely.
 */
export function sanitizeDeep(
  obj: unknown,
  config: DataSanitizationConfig,
  extraRedactFields?: string[],
): unknown {
  const redactFieldSet = new Set([...REDACT_FIELD_NAMES, ...(extraRedactFields ?? [])]);

  return walk(obj, config, redactFieldSet);
}

function walk(
  value: unknown,
  config: DataSanitizationConfig,
  redactFields: Set<string>,
  currentKey?: string,
): unknown {
  // If the current key is a redact-target, nuke the whole value
  if (currentKey && redactFields.has(currentKey)) {
    return REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return sanitize(value, config);
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, config, redactFields));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = walk(val, config, redactFields, key);
    }
    return result;
  }

  return value;
}

/**
 * Get the preset config for convenience.
 */
export function getPresetConfig(preset: SanitizationPreset): DataSanitizationConfig {
  return { preset };
}
