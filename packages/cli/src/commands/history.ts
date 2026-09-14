import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { registerLaunchCommand } from './launch.js';

export function registerHistoryCommands(program: Command, getClient: () => AutopodClient): void {
  registerLaunchCommand(program, getClient, undefined, { name: 'history', analysis: 'history' });
  registerLaunchCommand(program, getClient, undefined, {
    name: 'memory-workspace',
    analysis: 'memory',
  });
}
