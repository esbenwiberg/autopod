import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { registerLaunchCommand } from './launch.js';

/** Research uses the same repository/preset/config contract and publishes artifacts. */
export function registerResearchCommands(program: Command, getClient: () => AutopodClient): void {
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
