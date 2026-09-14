import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { registerLaunchCommand } from './launch.js';

/** Research uses the same repository/preset/config contract and publishes artifacts. */
export function registerResearchCommands(program: Command, getClient: () => AutopodClient): void {
  registerLaunchCommand(program, getClient, undefined, { name: 'research', output: 'artifact' });
}
