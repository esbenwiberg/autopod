import type {
  CheckpointPolicy,
  ScanCheckpoint,
  ScanDetectorName,
  ScanFinding,
  ScanOutcome,
  SecurityScanPolicy,
} from '@autopod/shared';

/** Bundled preset names — chosen by `name` if a profile omits `securityScan`. */
export type PolicyPreset = 'default' | 'strict' | 'relaxed';

/** Default list of always-scanned instruction files (globs, repo-relative). */
export const DEFAULT_ALWAYS_SCAN_PATHS: readonly string[] = [
  'CLAUDE.md',
  '**/CLAUDE.md',
  'AGENTS.md',
  '**/AGENTS.md',
  'ARCHITECTURE.md',
  '**/ARCHITECTURE.md',
  'README.md',
  'CONTRIBUTING.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.cursor/rules/**/*.md',
  '.aider.md',
  '.aider.conf.yml',
  '.windsurfrules',
  '.continuerules',
];

const DEFAULT_PRESET: SecurityScanPolicy = {
  detectors: {
    secrets: { enabled: true },
    pii: { enabled: false, threshold: 0.7 },
    injection: { enabled: false, threshold: 0.8 },
  },
  provisioning: {
    enabled: true,
    scope: 'auto',
    onSecret: 'warn',
    onPii: 'warn',
    onInjection: 'warn',
  },
  push: {
    enabled: true,
    scope: 'diff',
    onSecret: 'block',
    onPii: 'warn',
    onInjection: 'warn',
  },
};

const STRICT_PRESET: SecurityScanPolicy = {
  detectors: {
    secrets: { enabled: true },
    pii: { enabled: true, threshold: 0.5 },
    injection: { enabled: true, threshold: 0.6 },
  },
  provisioning: {
    enabled: true,
    scope: 'full',
    onSecret: 'block',
    onPii: 'block',
    onInjection: 'block',
  },
  push: {
    enabled: true,
    scope: 'full',
    onSecret: 'block',
    onPii: 'block',
    onInjection: 'block',
  },
};

const RELAXED_PRESET: SecurityScanPolicy = {
  detectors: {
    secrets: { enabled: true },
    pii: { enabled: false, threshold: 0.7 },
    injection: { enabled: false, threshold: 0.8 },
  },
  provisioning: {
    enabled: false,
    scope: 'auto',
    onSecret: 'warn',
    onPii: 'warn',
    onInjection: 'warn',
  },
  push: {
    enabled: true,
    scope: 'diff',
    onSecret: 'block',
    onPii: 'warn',
    onInjection: 'warn',
  },
};

const PRESETS: Record<PolicyPreset, SecurityScanPolicy> = {
  default: DEFAULT_PRESET,
  strict: STRICT_PRESET,
  relaxed: RELAXED_PRESET,
};

export function getPreset(preset: PolicyPreset = 'default'): SecurityScanPolicy {
  return clonePolicy(PRESETS[preset]);
}

export function resolvePolicy(
  profilePolicy: SecurityScanPolicy | null | undefined,
  preset: PolicyPreset = 'default',
): SecurityScanPolicy {
  return profilePolicy ? clonePolicy(profilePolicy) : getPreset(preset);
}

export interface DecisionInput {
  findings: ScanFinding[];
  checkpoint: ScanCheckpoint;
  policy: SecurityScanPolicy;
  /** Workspace pods rewrite `block` to `escalate` on the push checkpoint. */
  isWorkspacePod?: boolean;
}

export type ScanDecision = 'pass' | 'warn' | 'block' | 'escalate';

/**
 * Compute the overall decision for a scan run by inspecting findings against
 * the per-detector outcomes for the checkpoint. Order: block > escalate > warn > pass.
 */
export function decide(input: DecisionInput): ScanDecision {
  const checkpoint =
    input.checkpoint === 'provisioning' ? input.policy.provisioning : input.policy.push;
  if (!checkpoint.enabled) return 'pass';

  let highest: ScanDecision = 'pass';
  for (const finding of input.findings) {
    const outcome = outcomeFor(finding.detector, checkpoint);
    const next = outcomeToDecision(outcome);
    if (rank(next) > rank(highest)) highest = next;
  }

  // Workspace push override: rewrite block → escalate so the human-at-keyboard
  // can confirm rather than failing the pod.
  if (highest === 'block' && input.isWorkspacePod && input.checkpoint === 'push') {
    return 'escalate';
  }
  return highest;
}

function outcomeFor(detector: ScanDetectorName, policy: CheckpointPolicy): ScanOutcome {
  switch (detector) {
    case 'secrets':
      return policy.onSecret;
    case 'pii':
      return policy.onPii;
    case 'injection':
      return policy.onInjection;
  }
}

function outcomeToDecision(outcome: ScanOutcome): ScanDecision {
  switch (outcome) {
    case 'block':
      return 'block';
    case 'escalate':
      return 'escalate';
    case 'warn':
      return 'warn';
  }
}

function rank(decision: ScanDecision): number {
  switch (decision) {
    case 'block':
      return 3;
    case 'escalate':
      return 2;
    case 'warn':
      return 1;
    case 'pass':
      return 0;
  }
}

function clonePolicy(p: SecurityScanPolicy): SecurityScanPolicy {
  return JSON.parse(JSON.stringify(p)) as SecurityScanPolicy;
}
