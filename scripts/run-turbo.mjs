#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const task = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!task) {
  console.error('Usage: node scripts/run-turbo.mjs <task> [args...]');
  process.exit(1);
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function findFile(root, name, maxDepth = 4) {
  if (!existsSync(root) || maxDepth < 0) return null;

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isFile() && entry === name) return path;
    if (stats.isDirectory()) {
      const found = findFile(path, name, maxDepth - 1);
      if (found) return found;
    }
  }

  return null;
}

function findStoredPnpm() {
  if (commandExists('pnpm')) return null;

  const roots = [
    join(homedir(), 'Library/pnpm/store/v11/links/@/pnpm/9.15.4'),
    join(homedir(), '.local/share/pnpm/store/v11/links/@/pnpm/9.15.4'),
  ];

  for (const root of roots) {
    const found = findFile(root, 'pnpm');
    if (found) return dirname(found);
  }

  return null;
}

const pnpmBin = findStoredPnpm();
const env = {
  ...process.env,
  PATH: pnpmBin ? `${pnpmBin}:${process.env.PATH ?? ''}` : process.env.PATH,
};
const turbo = resolve('node_modules/.bin/turbo');
const result = spawnSync(turbo, ['run', task, ...extraArgs], { stdio: 'inherit', env });

process.exit(result.status ?? 1);
