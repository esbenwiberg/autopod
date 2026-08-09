import chalk from 'chalk';
import type { Command } from 'commander';
import { preflightEnvelope, preflightSeriesFolder } from './spec-preflight.js';

export function registerSpecCommands(program: Command): void {
  const spec = program.command('spec').description('Validate Autopod spec artifacts');

  spec
    .command('check <folder>')
    .description('Parse-check a /prep folder, /plan-feature folder, or investigation contract')
    .option('--json', 'Print versioned machine-readable diagnostics')
    .action((folder: string, opts: { json?: boolean }) => {
      const result=preflightSeriesFolder(folder); const envelope=preflightEnvelope(result);
      if (opts.json) console.log(JSON.stringify(envelope));
      else if (envelope.valid) { const facts=result.briefs?.reduce((n,b)=>n+(b.contract?.requiredFacts.length??0),0)??0; console.log(chalk.green(`Spec OK: ${result.briefFiles.length} briefs, ${facts} facts`)); }
      else console.error(chalk.red(`Spec check failed:\n${envelope.diagnostics.map(d=>`- ${d.source ?? ''} ${d.path}: ${d.message} Hint: ${d.hint}`).join('\n')}`));
      if (!envelope.valid) process.exit(1);
    });
}
