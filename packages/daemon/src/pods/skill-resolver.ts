import * as fs from 'node:fs/promises';
import { type InjectedSkill, processContent } from '@autopod/shared';
import type { Logger } from 'pino';

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
