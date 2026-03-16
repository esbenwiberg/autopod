import { Command } from 'commander';

const program = new Command();

program
  .name('ap')
  .description('Autopod — Sandboxed AI coding sessions with self-validation')
  .version('0.0.1');

program.parse(process.argv);
