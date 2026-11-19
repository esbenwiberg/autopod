import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { onTestFinished } from 'vitest';

export async function buildStartupHarness(entry = 'continuation-crash-fixture') {
  const daemon = path.resolve(import.meta.dirname, '../..');
  await mkdir(path.join(daemon, '.turbo'), { recursive: true });
  const dir = await mkdtemp(path.join(daemon, '.turbo', 'continuation-crash-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const bundle = path.join(dir, 'writer.mjs');
  await build({
    entryPoints: [path.join(daemon, `src/test-utils/${entry}.ts`)],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'external',
  });
  return bundle;
}
