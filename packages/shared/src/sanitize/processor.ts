import type { DataSanitizationConfig, QuarantineConfig } from '../types/actions.js';
import { sanitize, sanitizeDeep } from './sanitize.js';
import { quarantine, type ThreatIndicator } from './quarantine.js';

export interface ProcessedContent {
  /** The processed text */
  text: string;
  /** Whether PII sanitization was applied */
  sanitized: boolean;
  /** Whether quarantine wrapping was applied */
  quarantined: boolean;
  /** Threat indicators found (empty if quarantine not enabled) */
  threats: ThreatIndicator[];
}

export interface ProcessContentConfig {
  sanitization?: DataSanitizationConfig;
  quarantine?: Partial<QuarantineConfig>;
}

/**
 * Unified content processing pipeline: quarantine → sanitize.
 *
 * Order matters:
 * 1. Quarantine first — detect injection in the raw text before we modify it
 * 2. Sanitize second — strip PII from the (possibly quarantine-wrapped) text
 *
 * Both steps are optional — coding pods might only use PII, research pods use both.
 */
export function processContent(text: string, config: ProcessContentConfig): ProcessedContent {
  let result = text;
  let quarantined = false;
  let sanitized = false;
  let threats: ThreatIndicator[] = [];

  // Step 1: Quarantine (injection detection) — operates on raw text
  if (config.quarantine) {
    const qResult = quarantine(result, config.quarantine);
    result = qResult.sanitized;
    quarantined = !qResult.safe;
    threats = qResult.threats;
  }

  // Step 2: PII sanitization
  if (config.sanitization) {
    result = sanitize(result, config.sanitization);
    sanitized = true;
  }

  return { text: result, sanitized, quarantined, threats };
}

/**
 * Process an object tree: quarantine text fields, then deep-sanitize PII.
 * For structured API responses where we need both protections.
 */
export function processContentDeep(
  obj: unknown,
  config: ProcessContentConfig,
  extraRedactFields?: string[],
): { result: unknown; sanitized: boolean; quarantined: boolean; threats: ThreatIndicator[] } {
  // For deep processing, we quarantine string values inline and collect threats
  let quarantined = false;
  const allThreats: ThreatIndicator[] = [];

  // First pass: quarantine all string values
  let processed = obj;
  if (config.quarantine) {
    processed = walkQuarantine(obj, config.quarantine, (threats, isQuarantined) => {
      allThreats.push(...threats);
      if (isQuarantined) quarantined = true;
    });
  }

  // Second pass: PII sanitization
  let sanitized = false;
  if (config.sanitization) {
    processed = sanitizeDeep(processed, config.sanitization, extraRedactFields);
    sanitized = true;
  }

  return { result: processed, sanitized, quarantined, threats: allThreats };
}

function walkQuarantine(
  value: unknown,
  config: Partial<QuarantineConfig>,
  onThreat: (threats: ThreatIndicator[], quarantined: boolean) => void,
): unknown {
  if (typeof value === 'string') {
    const result = quarantine(value, config);
    if (result.threats.length > 0) {
      onThreat(result.threats, !result.safe);
    }
    return result.sanitized;
  }

  if (Array.isArray(value)) {
    return value.map((item) => walkQuarantine(item, config, onThreat));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = walkQuarantine(val, config, onThreat);
    }
    return result;
  }

  return value;
}
