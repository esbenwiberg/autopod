import type { ManagedCliConfig } from '../managed/cli-config.js';
import type { ManagedProfileSetConfig } from '../managed/profile-set-config.js';
import { enrolledOperator, type parseOperatorEnrollment } from './operator-enrollment.js';
import { operatorRunId } from './operator-runs.js';

// Partition by durable installation, never by potentially overlapping profile or runtime IDs.
export function operatorPartition(
  enrollment: ReturnType<typeof parseOperatorEnrollment>,
  cli: ManagedCliConfig | undefined,
  ordinary: ManagedProfileSetConfig | undefined,
  local: ManagedProfileSetConfig | undefined,
) {
  if (!local) return undefined;
  if (
    !enrollment ||
    !cli ||
    !ordinary ||
    ordinary.profiles.some((p) => p.profileSnapshot.route.executionTarget !== 'sandbox') ||
    local.profiles.some((p) => p.profileSnapshot.route.executionTarget !== 'local') ||
    local.catalogArtifacts ||
    local.githubRead ||
    local.source ||
    local.mirror.dependencyCachePath
  )
    throw new Error('operator-local-sandbox-pair-required');
  const run = operatorRunId(enrolledOperator(enrollment, cli, local), enrollment.slot);
  const operator = (installation: string) => installation === 'native.' + run;
  return { run, operator, ordinary: (installation: string) => !operator(installation) };
}
