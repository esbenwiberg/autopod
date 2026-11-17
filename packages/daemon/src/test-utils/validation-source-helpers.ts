import type { Pod, ValidationResult } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { PodRepository } from '../pods/pod-repository.js';

/** Unit-fixture premise only. Composed delivery incidents obtain this through the real engine owner. */
export function seedCheckedValidationSource(
  repo: PodRepository,
  pod: Pod,
  profile: PodExecutionSettings,
  result: ValidationResult,
  source = { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
) {
  const retries = repo.taskRetries;
  const sources = repo.validationSources;
  if (!retries || !sources) throw new Error('Missing validation ledgers');
  const attempt = retries.admit(
    pod.id,
    pod.lifecycleGeneration,
    { source: null, contract: null, commands: null, environment: null, implementation: null },
    'a'.repeat(64),
    [],
  );
  retries.start(attempt.id);
  const id = sources.begin(pod, profile, source, attempt.id);
  sources.finish(id, pod, profile, source, result);
  retries.finish(attempt.id, 'pass', 1);
  repo.update(pod.id, { lastValidationResult: result });
}
