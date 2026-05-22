import { parseDocument as parseYamlDocument } from 'yaml';

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  try {
    const frontmatter = (parseYamlDocument(match[1] ?? '').toJS() ?? {}) as Record<string, unknown>;
    return {
      name: asNonEmptyString(frontmatter.name),
      description: normalizeDescription(frontmatter.description),
    };
  } catch {
    return {};
  }
}

export function extractSkillDescription(content: string): string | null {
  return parseSkillFrontmatter(content).description ?? null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : undefined;
}
