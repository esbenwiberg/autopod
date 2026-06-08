import { AutopodError } from '@autopod/shared';
import type { ScheduledJobTemplateField } from '@autopod/shared';

const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export interface RenderScheduledJobPromptOptions {
  allowMissingRequired?: boolean;
}

export function normalizeTemplateFields(
  fields: ScheduledJobTemplateField[] | undefined,
): ScheduledJobTemplateField[] {
  const normalized = (fields ?? []).map((field) => {
    const result: ScheduledJobTemplateField = {
      key: field.key.trim(),
      label: field.label.trim(),
      required: field.required,
    };
    if (field.defaultValue !== undefined) result.defaultValue = field.defaultValue;
    return result;
  });

  const seen = new Set<string>();
  for (const field of normalized) {
    if (!FIELD_KEY_PATTERN.test(field.key)) {
      throw new AutopodError(
        `Invalid scheduled job template field key: "${field.key}"`,
        'INVALID_INPUT',
        400,
      );
    }
    if (field.label.length === 0) {
      throw new AutopodError(
        `Scheduled job template field "${field.key}" needs a label`,
        'INVALID_INPUT',
        400,
      );
    }
    const lowered = field.key.toLowerCase();
    if (seen.has(lowered)) {
      throw new AutopodError(
        `Duplicate scheduled job template field key: "${field.key}"`,
        'INVALID_INPUT',
        400,
      );
    }
    seen.add(lowered);
  }

  return normalized;
}

export function normalizeFieldValues(
  values: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!FIELD_KEY_PATTERN.test(key)) {
      throw new AutopodError(`Invalid scheduled job field key: "${key}"`, 'INVALID_INPUT', 400);
    }
    if (typeof value !== 'string') {
      throw new AutopodError(`Scheduled job field "${key}" must be a string`, 'INVALID_INPUT', 400);
    }
    result[key] = value;
  }
  return result;
}

export function validateTemplatePrompt(prompt: string, fields: ScheduledJobTemplateField[]): void {
  const known = new Set(fields.map((field) => field.key));
  for (const key of extractPlaceholderKeys(prompt)) {
    if (!FIELD_KEY_PATTERN.test(key)) {
      throw new AutopodError(
        `Invalid scheduled job template placeholder: "{{${key}}}"`,
        'INVALID_INPUT',
        400,
      );
    }
    if (!known.has(key)) {
      throw new AutopodError(
        `Scheduled job template placeholder "{{${key}}}" has no matching field`,
        'INVALID_INPUT',
        400,
      );
    }
  }
}

export function validateFieldValuesForTemplate(
  fields: ScheduledJobTemplateField[],
  values: Record<string, string>,
  options: RenderScheduledJobPromptOptions = {},
): Record<string, string> {
  const fieldKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!fieldKeys.has(key)) {
      throw new AutopodError(
        `Scheduled job override "${key}" is not defined by the selected template`,
        'INVALID_INPUT',
        400,
      );
    }
  }

  if (!options.allowMissingRequired) {
    for (const field of fields) {
      const value = values[field.key] ?? field.defaultValue ?? '';
      if (field.required && value.trim() === '') {
        throw new AutopodError(
          `Missing required scheduled job override: ${field.label}`,
          'INVALID_INPUT',
          400,
        );
      }
    }
  }

  return values;
}

export function filterFieldValuesForTemplate(
  fields: ScheduledJobTemplateField[],
  values: Record<string, string>,
): Record<string, string> {
  const fieldKeys = new Set(fields.map((field) => field.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => fieldKeys.has(key)));
}

export function renderScheduledJobPrompt(
  prompt: string,
  fields: ScheduledJobTemplateField[],
  values: Record<string, string>,
  options: RenderScheduledJobPromptOptions = {},
): string {
  validateTemplatePrompt(prompt, fields);
  validateFieldValuesForTemplate(fields, values, options);

  const byKey = new Map(fields.map((field) => [field.key, field]));
  return prompt.replace(PLACEHOLDER_PATTERN, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const field = byKey.get(key);
    if (!field) return '';
    return values[key] ?? field.defaultValue ?? '';
  });
}

function extractPlaceholderKeys(prompt: string): string[] {
  const keys: string[] = [];
  for (const match of prompt.matchAll(PLACEHOLDER_PATTERN)) {
    keys.push((match[1] ?? '').trim());
  }
  return keys;
}
