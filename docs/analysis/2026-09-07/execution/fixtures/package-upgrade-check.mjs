import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { migrationHash } from './verify-upgrade-copy.mjs';

const root = process.cwd();
const candidate = 'f93dd4d9a66bcf0a4ad174d0efc378d931239faf';
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('New absolute output directory required');
execFileSync(
  'git',
  ['diff', '--exit-code', candidate, '--', 'packages', 'package.json', 'pnpm-lock.yaml', 'scripts'],
  { stdio: 'pipe' },
);
fs.mkdirSync(output, { mode: 0o700 });
const require = createRequire(path.join(root, 'packages/daemon/package.json'));
const esbuild = createRequire(require.resolve('tsup'))('esbuild');
const result = esbuild.buildSync({
  entryPoints: ['packages/daemon/src/db/migrate.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['better-sqlite3'],
  metafile: true,
  outfile: path.join(output, 'candidate-migrations.mjs'),
});
const here = path.join(root, 'docs/analysis/2026-09-07/execution/fixtures');
for (const name of ['verify-upgrade-copy.mjs', 'verify-upgrade-copy-cli.mjs']) {
  fs.copyFileSync(path.join(here, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
}
fs.cpSync(path.join(root, 'packages/daemon/src/db/migrations'), path.join(output, 'migrations'), {
  recursive: true,
  errorOnExist: true,
});
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = {
  applicationCandidate: candidate,
  preparedAtHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceInputs: Object.keys(result.metafile.inputs)
    .sort()
    .map((file) => ({ file, sha256: digest(file) })),
  artifacts: [
    'candidate-migrations.mjs',
    'verify-upgrade-copy.mjs',
    'verify-upgrade-copy-cli.mjs',
  ].map((file) => ({ file, sha256: digest(path.join(output, file)) })),
  migrationSha256: migrationHash(path.join(output, 'migrations')),
  nativeDependencyBundled: false,
  nativeDependency: 'Compatible target-host better-sqlite3 required; no installation authorized',
  hostedExecuted: false,
  authority: 'Local preparation only; hosted upload and execution require separate approval',
};
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
console.log(
  JSON.stringify({ output, migrationSha256: manifest.migrationSha256, hostedExecuted: false }),
);
