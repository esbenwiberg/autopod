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

interface RedactMatcher {
  /** Bare key names that match anywhere (e.g. 'email', 'token'). */
  bareSet: Set<string>;
  /** Dotted entries, pre-split for structural suffix matching against the walk path. */
  dottedEntries: Array<{ joined: string; parts: string[] }>;
}

function buildMatcher(extraRedactFields: string[] | undefined): RedactMatcher {
  const bareSet = new Set<string>();
  const dottedEntries: Array<{ joined: string; parts: string[] }> = [];
  for (const entry of [...REDACT_FIELD_NAMES, ...(extraRedactFields ?? [])]) {
    if (entry.includes('.')) {
      dottedEntries.push({ joined: entry, parts: entry.split('.') });
    } else {
      bareSet.add(entry);
    }
  }
  return { bareSet, dottedEntries };
}

function shouldRedact(path: readonly string[], matcher: RedactMatcher): boolean {
  const last = path[path.length - 1];
  if (last === undefined) return false;
  if (matcher.bareSet.has(last)) return true;
  for (const entry of matcher.dottedEntries) {
    // Literal match against a flat-dotted key (e.g. pickFields output `"comments.content"`).
    if (entry.joined === last) return true;
    // Structural suffix match against nested traversal (e.g. ['createdBy','displayName']).
    if (entry.parts.length > path.length) continue;
    let ok = true;
    for (let i = 0; i < entry.parts.length; i++) {
      if (path[path.length - entry.parts.length + i] !== entry.parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Deep-sanitize an object tree: walk all string values and apply PII sanitization.
 * Also redacts known sensitive field names entirely. Dotted entries in
 * `extraRedactFields` (e.g. `createdBy.displayName`) match by structural suffix —
 * nested keys aligning with the dotted segments are redacted, regardless of how
 * deep the parent path goes. Array indices are NOT part of the matched path.
 */
export function sanitizeDeep(
  obj: unknown,
  config: DataSanitizationConfig,
  extraRedactFields?: string[],
): unknown {
  return walk(obj, config, buildMatcher(extraRedactFields), []);
}

function walk(
  value: unknown,
  config: DataSanitizationConfig,
  matcher: RedactMatcher,
  path: readonly string[],
): unknown {
  // If the current path is a redact-target, nuke the whole value
  if (shouldRedact(path, matcher)) {
    return REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return sanitize(value, config);
  }

  if (Array.isArray(value)) {
    // Array indices intentionally do not extend the path — dotted redact entries
    // describe structure, not element position.
    return value.map((item) => walk(item, config, matcher, path));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = walk(val, config, matcher, [...path, key]);
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
