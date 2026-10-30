import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { registerLaunchCommand } from './launch.js';

/** Research retains artifacts under the shared frozen findings-acceptance contract. */
export function registerResearchCommands(program: Command, getClient: () => AutopodClient): void {
  program
    .command('findings <id>')
    .description(
      'Read immutable findings receipts or an exact retained report, including archived pods',
    )
    .option('--generation <number>', 'Receipt lifecycle generation', Number)
    .option('--cycle <number>', 'Receipt worker cycle', Number)
    .option('--evidence-hash <hash>', 'Exact reviewed evidence hash')
    .option('--path <path>', 'Read a retained file; redirect binary content to a file')
    .action(
      async (
        id: string,
        opts: { generation?: number; cycle?: number; evidenceHash?: string; path?: string },
      ) => {
        if (!opts.path) {
          console.log(JSON.stringify(await getClient().getFindingsReceipts(id), null, 2));
          return;
        }
        if (opts.generation === undefined || opts.cycle === undefined || !opts.evidenceHash)
          throw new Error(
            'Report reads require --generation, --cycle and --evidence-hash from an immutable findings receipt.',
          );
        const file = await getClient().getFindingsFile(
          id,
          opts.generation,
          opts.cycle,
          opts.evidenceHash,
          opts.path,
        );
        process.stdout.write(Buffer.from(file.content, 'base64'));
      },
    );
  program
    .command('accept-findings <id>')
    .description(
      'Acknowledge exact reviewed findings; grants no implementation or publication authority',
    )
    .requiredOption('--generation <number>', 'Reviewed lifecycle generation', Number)
    .requiredOption('--cycle <number>', 'Reviewed worker cycle', Number)
    .requiredOption(
      '--evidence-hash <hash>',
      'Reviewed researchFindings.evidenceHash from ap status --json',
    )
    .action(
      async (id: string, opts: { generation: number; cycle: number; evidenceHash: string }) => {
        const receipt = await getClient().acceptFindings(id, {
          expectedGeneration: opts.generation,
          expectedCycle: opts.cycle,
          expectedEvidenceHash: opts.evidenceHash,
        });
        console.log(JSON.stringify(receipt, null, 2));
      },
    );
  registerLaunchCommand(program, getClient, undefined, { name: 'research', output: 'artifact' });
}
