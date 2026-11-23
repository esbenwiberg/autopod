/**
 * The one catalog of Azure Container Apps Sandboxes resource bundles Autopod offers.
 *
 * Azure sells fixed bundles: choosing a RAM size chooses the matching vCPU and disk.
 * Everything that needs a sandbox size — the tier type, default-tier parsing, the
 * maximum, daemon capabilities, the provisioning resolver and the Azure create
 * payload — derives from this list so the bundles cannot drift apart.
 *
 * Source: https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview#resource-tiers
 * and https://sandboxes.azure.com/docs/sandboxes/sandbox#resource-tiers. Every documented
 * tier is offered; bundles above L are per-repository opt-in.
 */

import { AutopodError } from '@autopod/shared';

export interface SandboxTierSpec {
  tier: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  /**
   * Opt-in bundles cost more per running second. They are never reached by
   * rounding a request up, and cannot be the fleet default: a repository must
   * select them explicitly by their exact RAM size.
   */
  optIn: boolean;
}

/** Ordered ascending by size. */
export const SANDBOX_TIERS = [
  { tier: 'XS', vcpu: 0.25, memoryGiB: 0.5, diskGiB: 5, optIn: false },
  { tier: 'S', vcpu: 0.5, memoryGiB: 1, diskGiB: 10, optIn: false },
  { tier: 'M', vcpu: 1, memoryGiB: 2, diskGiB: 20, optIn: false },
  { tier: 'L', vcpu: 2, memoryGiB: 4, diskGiB: 40, optIn: false },
  { tier: 'XL', vcpu: 4, memoryGiB: 8, diskGiB: 80, optIn: true },
  { tier: '2XL', vcpu: 8, memoryGiB: 16, diskGiB: 160, optIn: true },
  { tier: '3XL', vcpu: 16, memoryGiB: 32, diskGiB: 320, optIn: true },
] as const satisfies readonly SandboxTierSpec[];

export type SandboxResourceTier = (typeof SANDBOX_TIERS)[number]['tier'];
/** Tiers that may be the configured fleet default (never opt-in bundles). */
export type SandboxDefaultTier = Extract<(typeof SANDBOX_TIERS)[number], { optIn: false }>['tier'];

/** Fleet default when the operator configures nothing. Separate from the maximum. */
export const DEFAULT_SANDBOX_TIER: SandboxDefaultTier = 'L';
/** Largest bundle Autopod offers. */
export const MAX_SANDBOX_TIER: SandboxResourceTier = SANDBOX_TIERS[SANDBOX_TIERS.length - 1]!.tier;

const GIB = 1024 ** 3;

export function sandboxTier(tier: SandboxResourceTier): (typeof SANDBOX_TIERS)[number] {
  const spec = SANDBOX_TIERS.find((entry) => entry.tier === tier);
  if (!spec) throw new Error(`Unknown sandbox tier ${String(tier)}`);
  return spec;
}

export function sandboxTierMemoryBytes(tier: SandboxResourceTier): number {
  return sandboxTier(tier).memoryGiB * GIB;
}

/** Largest RAM any sandbox pod can get, in bytes. */
export const MAX_SANDBOX_MEMORY_BYTES = sandboxTierMemoryBytes(MAX_SANDBOX_TIER);

/** Azure create-payload `resources` for a tier. */
export function sandboxTierResources(tier: SandboxResourceTier): {
  cpu: string;
  memory: string;
  disk: string;
} {
  const spec = sandboxTier(tier);
  return {
    cpu: `${Math.round(spec.vcpu * 1000)}m`,
    memory: `${Math.round(spec.memoryGiB * 1024)}Mi`,
    disk: `${spec.diskGiB}Gi`,
  };
}

/** Human-readable bundle, e.g. `XL · 4 vCPU · 8 GiB RAM · 80 GiB disk`. */
export function sandboxTierLabel(tier: SandboxResourceTier): string {
  const spec = sandboxTier(tier);
  return `${spec.tier} · ${spec.vcpu} vCPU · ${spec.memoryGiB} GiB RAM · ${spec.diskGiB} GiB disk`;
}

const optInTiers = SANDBOX_TIERS.filter((entry) => entry.optIn);
const roundUpTiers = SANDBOX_TIERS.filter((entry) => !entry.optIn);

function joinAlternatives(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function formatGiB(bytes: number): string {
  return `${Number((bytes / GIB).toFixed(3))} GiB`;
}

/**
 * Resolve the bundle for a requested RAM size.
 *
 * - No hint (`undefined` / ≤ 0) → the configured default tier.
 * - Up to L: the smallest bundle that satisfies the request (XS–L round-up).
 * - Above L: must equal an opt-in bundle exactly (8 GiB = XL, 16 GiB = 2XL,
 *   32 GiB = 3XL).
 *   Anything else is refused before allocation — never rounded up to a larger,
 *   more expensive bundle and never clamped down.
 */
export function resolveSandboxTier(
  memoryBytes: number | undefined,
  defaultTier: SandboxResourceTier,
): SandboxResourceTier {
  if (!memoryBytes || memoryBytes <= 0) return defaultTier;
  for (const entry of roundUpTiers) {
    if (entry.memoryGiB * GIB >= memoryBytes) return entry.tier;
  }
  const exact = optInTiers.find((entry) => entry.memoryGiB * GIB === memoryBytes);
  if (exact) return exact.tier;
  const options = joinAlternatives(
    optInTiers.map((entry) => `${entry.tier} (${entry.memoryGiB} GiB)`),
  );
  throw new AutopodError(
    `Sandbox resource preflight failed: requested ${formatGiB(memoryBytes)} is not an offered sandbox bundle. Above ${roundUpTiers[roundUpTiers.length - 1]!.tier} (${roundUpTiers[roundUpTiers.length - 1]!.memoryGiB} GiB), select exactly ${options} in the repository's execution settings, or choose a compatible execution target. Larger sizes are not offered.`,
    'PREFLIGHT_INSUFFICIENT_MEMORY',
    409,
  );
}

/**
 * Parse the operator-configured fleet default (`AZURE_SANDBOX_TIER`). Only
 * non-opt-in tiers (≤ L) are valid; anything else is ignored with a warning and
 * the caller falls back to {@link DEFAULT_SANDBOX_TIER}.
 */
export function parseSandboxDefaultTier(value: string | undefined): {
  tier?: SandboxDefaultTier;
  warning?: string;
} {
  if (!value) return {};
  const match = SANDBOX_TIERS.find((entry) => entry.tier === value);
  const allowed = roundUpTiers.map((entry) => entry.tier).join(', ');
  if (match && !match.optIn) return { tier: match.tier as SandboxDefaultTier };
  if (match)
    return {
      warning: `Ignoring sandbox default tier ${match.tier}: larger tiers (${optInTiers.map((entry) => entry.tier).join(', ')}) are per-repository opt-in and cannot be the fleet default; expected ${allowed}`,
    };
  return { warning: `Ignoring invalid sandbox tier; expected ${allowed}` };
}
