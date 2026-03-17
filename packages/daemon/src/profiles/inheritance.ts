import type { EscalationConfig, Profile } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { mergeMcpServers, mergeClaudeMdSections } from '../sessions/injection-merger.js';

const MAX_INHERITANCE_DEPTH = 5;

/** Fields that are never inherited — always come from the child profile. */
const NEVER_INHERITED: ReadonlySet<keyof Profile> = new Set([
  'name',
  'extends',
  'createdAt',
  'updatedAt',
]);

/** Fields that have special merge logic instead of simple override. */
const SPECIAL_MERGE_FIELDS: ReadonlySet<keyof Profile> = new Set([
  'validationPages',
  'escalation',
  'customInstructions',
  'mcpServers',
  'claudeMdSections',
]);

/**
 * Resolve inheritance between a child and parent profile.
 * Assumes the parent is already fully resolved (recursive resolution
 * should happen before calling this).
 */
export function resolveInheritance(child: Profile, parent: Profile): Profile {
  const resolved = { ...child };

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

  // validationPages: parent pages first, then child pages appended
  resolved.validationPages = [...parent.validationPages, ...child.validationPages];

  // escalation: deep merge — child overrides individual keys
  resolved.escalation = {
    ...parent.escalation,
    ...child.escalation,
    askAi: {
      ...parent.escalation.askAi,
      ...child.escalation?.askAi,
    },
  } as EscalationConfig;

  // customInstructions: concatenate with separator
  if (parent.customInstructions && child.customInstructions) {
    resolved.customInstructions = `${parent.customInstructions}\n\n${child.customInstructions}`;
  } else {
    resolved.customInstructions = child.customInstructions ?? parent.customInstructions;
  }

  // mcpServers: merge by name (parent first, child overrides)
  resolved.mcpServers = mergeMcpServers(parent.mcpServers, child.mcpServers);

  // claudeMdSections: merge by heading (parent first, child overrides)
  resolved.claudeMdSections = mergeClaudeMdSections(parent.claudeMdSections, child.claudeMdSections);

  return resolved;
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
