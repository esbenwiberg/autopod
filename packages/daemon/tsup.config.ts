import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { collectImplementationIdentity } from './src/runtimes/build-input-identity.js';

let commitSha: string | null = null;
let dirty: boolean | null = null;
try {
  const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (/^[a-f0-9]{40}$/.test(candidate)) commitSha = candidate;
  dirty =
    execFileSync(
      'git',
      [
        'status',
        '--porcelain',
        '--',
        ':(top)packages',
        ':(top)package.json',
        ':(top)pnpm-lock.yaml',
        ':(top)pnpm-workspace.yaml',
        ':(top)turbo.json',
        ':(top)tsconfig.base.json',
      ],
      { encoding: 'utf8' },
    ).trim().length > 0;
} catch {
  /* copied source with no git evidence is explicitly unidentified */
}
const release = {
  validationImplementationHash: collectImplementationIdentity(),
  commitSha,
  dirty,
  builtAt: new Date().toISOString(),
  source: commitSha ? 'build' : 'unavailable',
};

export default defineConfig({
  define: { __AUTOPOD_RELEASE__: JSON.stringify(release) },
  entry: ['src/index.ts', 'src/db/verify-backup-cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['better-sqlite3', 'pino-pretty'],
  onSuccess: async () => {
    if (process.env.AUTOPOD_TYPECHECK === '1') return;
    mkdirSync('dist/db/migrations', { recursive: true });
    cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
    mkdirSync('dist/actions/defaults', { recursive: true });
    cpSync('src/actions/defaults', 'dist/actions/defaults', { recursive: true });
    mkdirSync('dist/containers', { recursive: true });
    cpSync('src/containers/seccomp-profile.json', 'dist/containers/seccomp-profile.json');
    mkdirSync('dist/images', { recursive: true });
    cpSync('src/images/image-digests.json', 'dist/images/image-digests.json');
    cpSync('src/images/dagger-cli-version.json', 'dist/images/dagger-cli-version.json');
  },
});
