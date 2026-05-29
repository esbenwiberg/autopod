#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/run-pnpm.mjs <pnpm-args...>');
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

function findStoredPnpmBin() {
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

let command = 'npx';
let commandArgs = ['pnpm', ...args];
const storedPnpmBin = findStoredPnpmBin();
const env = {
  ...process.env,
  PATH: storedPnpmBin ? `${storedPnpmBin}:${process.env.PATH ?? ''}` : process.env.PATH,
};

if (commandExists('pnpm')) {
  command = 'pnpm';
  commandArgs = args;
} else if (storedPnpmBin) {
  command = join(storedPnpmBin, 'pnpm');
  commandArgs = args;
}

const result = spawnSync(command, commandArgs, { stdio: 'inherit', env });
process.exit(result.status ?? 1);
