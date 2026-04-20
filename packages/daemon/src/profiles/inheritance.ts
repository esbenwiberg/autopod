import type { EscalationConfig, MergeStrategy, Profile } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { mergeClaudeMdSections, mergeMcpServers, mergeSkills } from '../pods/injection-merger.js';

const MAX_INHERITANCE_DEPTH = 5;

/** Fields that are never inherited — always come from the child profile. */
const NEVER_INHERITED: ReadonlySet<keyof Profile> = new Set([
  'name',
  'extends',
  'createdAt',
  'updatedAt',
  'mergeStrategy',
]);

/** Fields that have special merge logic instead of simple override. */
const SPECIAL_MERGE_FIELDS: ReadonlySet<keyof Profile> = new Set([
  'smokePages',
  'escalation',
  'customInstructions',
  'mcpServers',
  'claudeMdSections',
  'skills',
  'privateRegistries',
]);

/**
 * Resolve inheritance between a child and parent profile.
 * Assumes the parent is already fully resolved (recursive resolution
 * should happen before calling this).
 */
export function resolveInheritance(child: Profile, parent: Profile): Profile {
  const resolved = { ...child };
  const strategy: MergeStrategy = child.mergeStrategy ?? {};

  // Simple fields: inherit from parent if child has the default/null value
  for (const key of Object.keys(parent) as (keyof Profile)[]) {
    if (NEVER_INHERITED.has(key) || SPECIAL_MERGE_FIELDS.has(key)) continue;

    const childValue = child[key];
    // If child has null/undefined, inherit from parent
    if (childValue === null || childValue === undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic property assignment across union types
      (resolved as any)[key] = parent[key];
    }
  }

  // smokePages: parent pages first, then child pages appended (or child-only on replace)
  resolved.smokePages =
    strategy.smokePages === 'replace'
      ? child.smokePages
      : [...parent.smokePages, ...child.smokePages];

  // escalation: deep merge — child overrides individual keys (or child-only on replace).
  // Either side may be null on raw profiles; null child means "inherit".
  if (strategy.escalation === 'replace') {
    resolved.escalation = child.escalation;
  } else if (child.escalation === null) {
    resolved.escalation = parent.escalation;
  } else if (parent.escalation === null) {
    resolved.escalation = child.escalation;
  } else {
    resolved.escalation = {
      ...parent.escalation,
      ...child.escalation,
      askAi: {
        ...parent.escalation.askAi,
        ...child.escalation.askAi,
      },
      advisor: {
        ...parent.escalation.advisor,
        ...child.escalation.advisor,
      },
    } as EscalationConfig;
  }

  // customInstructions: concatenate with separator (or use child-only — including null — on replace)
  if (strategy.customInstructions === 'replace') {
    resolved.customInstructions = child.customInstructions;
  } else if (parent.customInstructions && child.customInstructions) {
    resolved.customInstructions = `${parent.customInstructions}\n\n${child.customInstructions}`;
  } else {
    resolved.customInstructions = child.customInstructions ?? parent.customInstructions;
  }

  // mcpServers: merge by name (parent first, child overrides) or child-only on replace
  resolved.mcpServers =
    strategy.mcpServers === 'replace'
      ? child.mcpServers
      : mergeMcpServers(parent.mcpServers, child.mcpServers);

  // claudeMdSections: merge by heading (or child-only on replace)
  resolved.claudeMdSections =
    strategy.claudeMdSections === 'replace'
      ? child.claudeMdSections
      : mergeClaudeMdSections(parent.claudeMdSections, child.claudeMdSections);

  // skills: merge by name (or child-only on replace)
  resolved.skills =
    strategy.skills === 'replace' ? child.skills : mergeSkills(parent.skills, child.skills);

  // privateRegistries: concatenate (parent first, child appended — same feed URL deduped)
  // or child-only on replace
  if (strategy.privateRegistries === 'replace') {
    resolved.privateRegistries = child.privateRegistries;
  } else {
    const seenUrls = new Set<string>();
    const mergedRegistries = [];
    for (const reg of [...parent.privateRegistries, ...child.privateRegistries]) {
      if (!seenUrls.has(reg.url)) {
        seenUrls.add(reg.url);
        mergedRegistries.push(reg);
      }
    }
    resolved.privateRegistries = mergedRegistries;
  }

  return resolved;
}

/**
 * Where each field of a resolved profile came from:
 * - 'own'       — the child explicitly set this value (non-null; non-sentinel-empty for merge-special fields)
 * - 'inherited' — the child left the field null/empty and the parent supplied the value
 * - 'merged'    — both sides contributed to a merge-special field (strategy !== 'replace')
 *
 * The map is keyed by Profile field names but typed loosely so it can be
 * serialized to JSON and consumed by the desktop client.
 */
export type FieldSource = 'own' | 'inherited' | 'merged';

/** Fields of Profile that buildSourceMap always classifies as 'own' on the child. */
const SELF_ONLY_FIELDS: ReadonlySet<keyof Profile> = new Set([
  'name',
  'extends',
  'createdAt',
  'updatedAt',
  'mergeStrategy',
]);

function isEmptyForMergeField(key: keyof Profile, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  // escalation is an object; treat presence as non-empty
  void key;
  return false;
}

export function buildSourceMap(raw: Profile, parent: Profile | null): Record<string, FieldSource> {
  const map: Record<string, FieldSource> = {};
  const strategy = raw.mergeStrategy ?? {};

  // Base profile: everything is 'own'.
  if (parent === null) {
    for (const key of Object.keys(raw) as (keyof Profile)[]) {
      map[key as string] = 'own';
    }
    return map;
  }

  for (const key of Object.keys(raw) as (keyof Profile)[]) {
    if (SELF_ONLY_FIELDS.has(key)) {
      map[key as string] = 'own';
      continue;
    }

    if (SPECIAL_MERGE_FIELDS.has(key)) {
      const childEmpty = isEmptyForMergeField(key, raw[key]);
      const mode = strategy[key as keyof typeof strategy];
      if (mode === 'replace') {
        map[key as string] = 'own';
      } else if (childEmpty) {
        map[key as string] = 'inherited';
      } else {
        // child has a value; it's merged with parent by default
        map[key as string] = 'merged';
      }
      continue;
    }

    // Simple field: null/undefined on child → inherited
    const childValue = raw[key];
    map[key as string] = childValue === null || childValue === undefined ? 'inherited' : 'own';
  }

  return map;
}

/**
 * Detect circular inheritance in a profile chain.
 * @param startName - The profile name to start checking from
 * @param getExtends - Function that returns the `extends` value for a given profile name
 * @throws AutopodError if a cycle is detected or chain exceeds max depth
 */
export function validateInheritanceChain(
  startName: string,
  getExtends: (name: string) => string | null,
): void {
  const visited: string[] = [startName];
  let current = getExtends(startName);

  while (current !== null) {
    if (visited.includes(current)) {
      visited.push(current);
      throw new AutopodError(
        `Circular inheritance detected: ${visited.join(' → ')}`,
        'CIRCULAR_INHERITANCE',
        400,
      );
    }

    visited.push(current);

    // visited includes start node + all ancestors; more than MAX+1 means too many levels
    if (visited.length > MAX_INHERITANCE_DEPTH) {
      throw new AutopodError(
        `Inheritance chain too deep (max ${MAX_INHERITANCE_DEPTH} levels)`,
        'INHERITANCE_TOO_DEEP',
        400,
      );
    }

    current = getExtends(current);
  }
}
