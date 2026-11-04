import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function registerRetainedContinuationCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('retained-continuation <id>')
    .description(
      'Preserve original resources; select independent source for repair or fresh checks without a coding worker',
    )
    .option('--apply', 'Prepare exact retained source; queue checks unless --prepare-only')
    .option('--prepare-only', 'Prepare an independent repair checkout; do not queue checks')
    .option(
      '--check',
      'Select the exact final committed candidate of an existing prepared operation',
    )
    .option('--request-id <id>', 'Stable recovery ID; reuse to observe an uncertain response')
    .option('--generation <number>', 'Exact original lifecycle generation')
    .option('--result-hash <sha256>', 'Exact original stored result hash')
    .option('--head <sha>', 'Exact original retained host HEAD')
    .option(
      '--remote-head <sha>',
      'Exact current published source branch HEAD to select independently',
    )
    .option('--candidate-head <sha>', 'Exact committed repair candidate to check')
    .option('--reason <text>', 'Human source-selection reason (10–4000 characters)')
    .option(
      '--preview-execution <profile>',
      'Preview replacement software/resources without changing task authority',
    )
    .option(
      '--execution-profile <profile>',
      'Explicit execution selection at preparation or, if not selected yet, --check',
    )
    .option('--execution-digest <sha256>', 'Exact replacement execution preview digest')
    .option('--json', 'Output JSON')
    .action(
      async (
        id: string,
        opts: {
          apply?: boolean;
          prepareOnly?: boolean;
          check?: boolean;
          requestId?: string;
          generation?: string;
          resultHash?: string;
          head?: string;
          remoteHead?: string;
          candidateHead?: string;
          reason?: string;
          json?: boolean;
          previewExecution?: string;
          executionProfile?: string;
          executionDigest?: string;
        },
      ) => {
        const mutation =
          opts.prepareOnly ||
          opts.requestId ||
          opts.generation ||
          opts.resultHash ||
          opts.head ||
          opts.remoteHead ||
          opts.candidateHead ||
          opts.executionProfile ||
          opts.executionDigest ||
          opts.reason;
        if (opts.previewExecution && (mutation || opts.apply || opts.check))
          throw new Error('Execution preview is read-only; omit mutation flags.');
        if (
          Boolean(opts.executionProfile) !== Boolean(opts.executionDigest) ||
          (opts.executionDigest && !/^[a-f0-9]{64}$/.test(opts.executionDigest))
        )
          throw new Error(
            'Execution selection requires --execution-profile and the exact --execution-digest.',
          );
        if (!opts.apply && !opts.check && mutation)
          throw new Error('Mutation fields require --apply or --check.');
        if (opts.apply && opts.check) throw new Error('Choose --apply or --check, not both.');
        if (opts.check && (opts.head || opts.remoteHead || opts.prepareOnly))
          throw new Error('--check selects an existing candidate, not another source.');
        if (opts.apply || opts.check) {
          if (
            !opts.requestId ||
            !opts.generation ||
            !opts.resultHash ||
            !opts.reason ||
            (opts.apply ? !opts.head || opts.candidateHead : !opts.candidateHead)
          )
            throw new Error(
              'Selection requires --request-id, --generation, --result-hash, --reason and the exact --head or --candidate-head.',
            );
          if (
            !/^[a-zA-Z0-9-]{1,64}$/.test(opts.requestId) ||
            !/^[1-9][0-9]*$/.test(opts.generation) ||
            !Number.isSafeInteger(Number(opts.generation)) ||
            !/^[a-f0-9]{64}$/.test(opts.resultHash) ||
            !sha.test((opts.check ? opts.candidateHead : opts.head) ?? '') ||
            (opts.remoteHead !== undefined && !sha.test(opts.remoteHead)) ||
            opts.reason.trim().length < 10 ||
            opts.reason.length > 4000
          )
            throw new Error(
              'Invalid recovery ID, generation, exact SHA/hash or meaningful reason.',
            );
        }
        const client = getClient();
        const podId = await resolvePodId(client, id);
        const result = opts.previewExecution
          ? await client.previewRetainedExecution(podId, opts.previewExecution)
          : opts.check
            ? await client.checkRetainedCandidate(podId, opts.requestId as string, {
                expectedGeneration: Number(opts.generation),
                expectedResultHash: opts.resultHash as string,
                candidateHead: opts.candidateHead as string,
                ...(opts.executionProfile
                  ? {
                      executionProfileId: opts.executionProfile,
                      expectedExecutionDigest: opts.executionDigest,
                    }
                  : {}),
                reason: opts.reason as string,
              })
            : opts.apply
              ? await client.continueRetained(podId, {
                  id: opts.requestId as string,
                  expectedGeneration: Number(opts.generation),
                  expectedResultHash: opts.resultHash as string,
                  checkpointHead: opts.head as string,
                  ...(opts.remoteHead ? { remoteHead: opts.remoteHead } : {}),
                  prepareOnly: opts.prepareOnly ?? false,
                  ...(opts.executionProfile
                    ? {
                        executionProfileId: opts.executionProfile,
                        expectedExecutionDigest: opts.executionDigest,
                      }
                    : {}),
                  reason: opts.reason as string,
                })
              : await client.getCheckpointRecoveries(podId);
        withJsonOutput(opts, result, (value) => {
          console.log(JSON.stringify(value, null, 2));
          console.log(
            'Accepted is not passing checks. Originals remain retained; retry permission, qualified infrastructure and fresh approval are separate.',
          );
        });
      },
    );
}
