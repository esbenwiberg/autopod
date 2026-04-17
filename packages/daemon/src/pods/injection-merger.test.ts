import type { InjectedClaudeMdSection, InjectedMcpServer, InjectedSkill } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { mergeClaudeMdSections, mergeMcpServers, mergeSkills } from './injection-merger.js';

describe('mergeMcpServers', () => {
  it('returns empty array when both inputs are empty', () => {
    expect(mergeMcpServers([], [])).toEqual([]);
  });

  it('returns daemon servers when profile is empty', () => {
    const daemon: InjectedMcpServer[] = [{ name: 'prism', url: 'https://prism.io/mcp' }];
    expect(mergeMcpServers(daemon, [])).toEqual(daemon);
  });

  it('returns profile servers when daemon is empty', () => {
    const profile: InjectedMcpServer[] = [{ name: 'sentry', url: 'https://sentry.io/mcp' }];
    expect(mergeMcpServers([], profile)).toEqual(profile);
  });

  it('combines servers with different names', () => {
    const daemon: InjectedMcpServer[] = [{ name: 'prism', url: 'https://prism.io/mcp' }];
    const profile: InjectedMcpServer[] = [{ name: 'sentry', url: 'https://sentry.io/mcp' }];
    const result = mergeMcpServers(daemon, profile);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual(['prism', 'sentry']);
  });

  it('profile overrides daemon server with same name', () => {
    const daemon: InjectedMcpServer[] = [
      { name: 'prism', url: 'https://prism.io/v1/mcp', description: 'daemon version' },
    ];
    const profile: InjectedMcpServer[] = [
      { name: 'prism', url: 'https://prism.io/v2/mcp', description: 'profile version' },
    ];
    const result = mergeMcpServers(daemon, profile);
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://prism.io/v2/mcp');
    expect(result[0]?.description).toBe('profile version');
  });
});

describe('mergeClaudeMdSections', () => {
  it('returns empty array when both inputs are empty', () => {
    expect(mergeClaudeMdSections([], [])).toEqual([]);
  });

  it('returns daemon sections when profile is empty', () => {
    const daemon: InjectedClaudeMdSection[] = [{ heading: 'Architecture', content: 'monolith' }];
    expect(mergeClaudeMdSections(daemon, [])).toEqual(daemon);
  });

  it('profile overrides daemon section with same heading', () => {
    const daemon: InjectedClaudeMdSection[] = [{ heading: 'Architecture', content: 'monolith' }];
    const profile: InjectedClaudeMdSection[] = [
      { heading: 'Architecture', content: 'microservices' },
    ];
    const result = mergeClaudeMdSections(daemon, profile);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('microservices');
  });

  it('sorts by priority (lower number first)', () => {
    const daemon: InjectedClaudeMdSection[] = [
      { heading: 'Guidelines', priority: 80, content: 'rules' },
      { heading: 'Architecture', priority: 10, content: 'overview' },
    ];
    const profile: InjectedClaudeMdSection[] = [
      { heading: 'Dependencies', priority: 50, content: 'deps' },
    ];
    const result = mergeClaudeMdSections(daemon, profile);
    expect(result.map((s) => s.heading)).toEqual(['Architecture', 'Dependencies', 'Guidelines']);
  });

  it('uses default priority 50 when not specified', () => {
    const daemon: InjectedClaudeMdSection[] = [{ heading: 'First', priority: 10, content: 'a' }];
    const profile: InjectedClaudeMdSection[] = [
      { heading: 'Middle', content: 'b' }, // default priority 50
    ];
    const result = mergeClaudeMdSections(daemon, profile);
    expect(result[0]?.heading).toBe('First');
    expect(result[1]?.heading).toBe('Middle');
  });
});

describe('mergeSkills', () => {
  it('returns empty array when both inputs are empty', () => {
    expect(mergeSkills([], [])).toEqual([]);
  });

  it('returns daemon skills when profile is empty', () => {
    const daemon: InjectedSkill[] = [
      { name: 'review', source: { type: 'local', path: '/skills/review.md' } },
    ];
    expect(mergeSkills(daemon, [])).toEqual(daemon);
  });

  it('returns profile skills when daemon is empty', () => {
    const profile: InjectedSkill[] = [
      { name: 'deploy', source: { type: 'github', repo: 'org/skills' } },
    ];
    expect(mergeSkills([], profile)).toEqual(profile);
  });

  it('combines skills with different names', () => {
    const daemon: InjectedSkill[] = [
      { name: 'review', source: { type: 'local', path: '/skills/review.md' } },
    ];
    const profile: InjectedSkill[] = [
      { name: 'deploy', source: { type: 'github', repo: 'org/skills' } },
    ];
    const result = mergeSkills(daemon, profile);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual(['review', 'deploy']);
  });

  it('profile overrides daemon skill with same name', () => {
    const daemon: InjectedSkill[] = [
      { name: 'review', source: { type: 'local', path: '/old/review.md' }, description: 'old' },
    ];
    const profile: InjectedSkill[] = [
      { name: 'review', source: { type: 'github', repo: 'org/skills' }, description: 'new' },
    ];
    const result = mergeSkills(daemon, profile);
    expect(result).toHaveLength(1);
    expect(result[0]?.source.type).toBe('github');
    expect(result[0]?.description).toBe('new');
  });
});
