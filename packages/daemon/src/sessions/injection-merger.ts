import type { InjectedClaudeMdSection, InjectedMcpServer } from '@autopod/shared';

/**
 * Merge daemon-level and profile-level MCP server injections.
 * Profile entries override daemon entries with the same name.
 */
export function mergeMcpServers(
  daemon: InjectedMcpServer[],
  profile: InjectedMcpServer[],
): InjectedMcpServer[] {
  const merged = new Map<string, InjectedMcpServer>();
  for (const s of daemon) merged.set(s.name, s);
  for (const s of profile) merged.set(s.name, s); // profile wins
  return [...merged.values()];
}

/**
 * Merge daemon-level and profile-level CLAUDE.md section injections.
 * Profile entries override daemon entries with the same heading.
 * Result is sorted by priority (lower = earlier in document).
 */
export function mergeClaudeMdSections(
  daemon: InjectedClaudeMdSection[],
  profile: InjectedClaudeMdSection[],
): InjectedClaudeMdSection[] {
  const merged = new Map<string, InjectedClaudeMdSection>();
  for (const s of daemon) merged.set(s.heading, s);
  for (const s of profile) merged.set(s.heading, s); // profile wins
  return [...merged.values()].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
}
