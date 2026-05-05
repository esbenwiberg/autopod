import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type InjectedSkill, processContent } from '@autopod/shared';
import type { Logger } from 'pino';

/** Directory scanned for builtin (daemon-bundled) skills. Override via SKILLS_DIR env var. */
export const BUILTIN_SKILLS_DIR = process.env.SKILLS_DIR ?? path.resolve(process.cwd(), 'skills');

export interface BuiltinSkillMeta {
  name: string;
  description: string | null;
}

/**
 * List all .md files in the builtin skills directory and extract their frontmatter name/description.
 * Returns an empty array if the directory doesn't exist.
 */
export async function listBuiltinSkills(): Promise<BuiltinSkillMeta[]> {
  let entries: string[];
  try {
    const dirents = await fs.readdir(BUILTIN_SKILLS_DIR);
    entries = dirents.filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries.map(async (file): Promise<BuiltinSkillMeta> => {
      const name = file.replace(/\.md$/, '');
      try {
        const content = await fs.readFile(path.join(BUILTIN_SKILLS_DIR, file), 'utf-8');
        const description = extractFrontmatterField(content, 'description');
        return { name, description };
      } catch {
        return { name, description: null };
      }
    }),
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function extractFrontmatterField(content: string, field: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return null;
  const block = match[1];
  // Handle multi-line quoted values (description: "..." or description: >)
  const inlineMatch = block.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return inlineMatch?.[1]?.trim() ?? null;
}

export interface ResolvedSkill {
  /** Skill name — used as the slash command name and filename */
  name: string;
  /** Markdown content of the skill */
  content: string;
}

/**
 * Sanitize fetched skill content. Local skills are operator-controlled; GitHub
 * skills are fetched over the network and may carry prompt-injection or PII.
 * We quarantine but don't drop — a flagged skill is still injected so the
 * agent can see the warning markers.
 */
function sanitizeSkillContent(content: string): string {
  const result = processContent(content, {
    sanitization: { preset: 'standard' },
    quarantine: { enabled: true },
  });
  return result.text;
}

/**
 * Resolve skill content from their configured sources.
 * Never throws. Failed resolutions are logged and silently skipped.
 */
export async function resolveSkills(
  skills: InjectedSkill[],
  logger: Logger,
): Promise<ResolvedSkill[]> {
  const results = await Promise.allSettled(skills.map((s) => resolveOne(s, logger)));

  return results
    .filter((r): r is PromiseFulfilledResult<ResolvedSkill | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((s): s is ResolvedSkill => s !== null);
}

async function resolveOne(skill: InjectedSkill, logger: Logger): Promise<ResolvedSkill | null> {
  const { source } = skill;

  try {
    switch (source.type) {
      case 'local':
        return await resolveLocal(skill, source.path, logger);
      case 'builtin':
        return await resolveLocal(skill, path.join(BUILTIN_SKILLS_DIR, `${skill.name}.md`), logger);
      case 'github':
        return await resolveGithub(skill, source, logger);
      default:
        logger.warn({ skill: skill.name }, 'Unknown skill source type — skipping');
        return null;
    }
  } catch (err) {
    logger.warn({ err, skill: skill.name }, 'Skill resolution failed — skipping');
    return null;
  }
}

async function resolveLocal(
  skill: InjectedSkill,
  filePath: string,
  logger: Logger,
): Promise<ResolvedSkill | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    logger.debug({ skill: skill.name, path: filePath }, 'Local skill resolved');
    return { name: skill.name, content: sanitizeSkillContent(content) };
  } catch (err) {
    logger.warn(
      { err, skill: skill.name, path: filePath },
      'Failed to read local skill file — skipping',
    );
    return null;
  }
}

async function resolveGithub(
  skill: InjectedSkill,
  source: { repo: string; path?: string; ref?: string; token?: string },
  logger: Logger,
): Promise<ResolvedSkill | null> {
  const ref = source.ref ?? 'main';
  // Only full 40-char commit SHAs are accepted. Branch names and tags can be force-pushed
  // to point at malicious content; a pinned SHA is immutable.
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    logger.warn(
      { skill: skill.name, repo: source.repo, ref },
      'Skill ref is not a full 40-character commit SHA — skipping skill. Pin to a commit SHA.',
    );
    return null;
  }
  const filePath = source.path ?? `${skill.name}.md`;
  const url = `https://api.github.com/repos/${source.repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.raw',
    'User-Agent': 'autopod-daemon',
  };
  if (source.token) {
    headers.Authorization = `Bearer ${source.token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn(
        { skill: skill.name, repo: source.repo, status: res.status },
        'GitHub skill fetch failed — skipping',
      );
      return null;
    }

    const content = await res.text();
    logger.debug(
      { skill: skill.name, repo: source.repo, ref, path: filePath },
      'GitHub skill resolved',
    );
    return { name: skill.name, content: sanitizeSkillContent(content) };
  } catch (err) {
    clearTimeout(timeout);
    logger.warn(
      { err, skill: skill.name, repo: source.repo },
      'GitHub skill fetch error — skipping',
    );
    return null;
  }
}
