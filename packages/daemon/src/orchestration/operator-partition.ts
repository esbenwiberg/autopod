import type { ManagedCliConfig } from '../managed/cli-config.js';
import type { ManagedProfileSetConfig } from '../managed/profile-set-config.js';
import { enrolledOperator, type parseOperatorEnrollment } from './operator-enrollment.js';
import { operatorRunId } from './operator-runs.js';

// Partition by durable installation, never by potentially overlapping profile or runtime IDs.
export function operatorPartition(
  enrollment: ReturnType<typeof parseOperatorEnrollment>,
  cli: ManagedCliConfig | undefined,
  ordinary: ManagedProfileSetConfig | undefined,
  worker: ManagedProfileSetConfig | undefined,
  candidateOnly = false,
) {
  if (!worker && !candidateOnly) return undefined;
  const target = worker.profiles[0]?.profileSnapshot.route.executionTarget;
  if (
    !enrollment ||
    !cli ||
    !worker ||
    (candidateOnly
      ? ordinary || !enrollment.parent?.coding?.sandbox?.hostQualification || target !== 'sandbox'
      : !ordinary ||
        ordinary.profiles.some((p) => p.profileSnapshot.route.executionTarget !== 'sandbox')) ||
    (target !== 'local' && target !== 'sandbox') ||
    worker.profiles.some((p) => p.profileSnapshot.route.executionTarget !== target) ||
    worker.catalogArtifacts ||
    worker.githubRead ||
    worker.source ||
    worker.mirror.dependencyCachePath
  )
    throw new Error('operator-local-sandbox-pair-required');
  const run = operatorRunId(enrolledOperator(enrollment, cli, worker), enrollment.slot);
  const operator = (installation: string) => installation === 'native.' + run;
  return { run, operator, target, ordinary: (installation: string) => !operator(installation) };
}
