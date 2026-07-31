import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const imageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(imageDir, '../../../..');
const execFileAsync = promisify(execFile);

const playwrightBaseTemplates = [
  'Dockerfile.node22-pw',
  'Dockerfile.node22-pw-pg',
  'Dockerfile.go124-pw',
  'Dockerfile.python-node-pg',
  'Dockerfile.dotnet10',
  'Dockerfile.dotnet10-go',
];

const workerBaseTemplates = [
  'Dockerfile.dotnet9',
  'Dockerfile.dotnet10',
  'Dockerfile.dotnet10-go',
  'Dockerfile.go124',
  'Dockerfile.go124-pw',
  'Dockerfile.node22',
  'Dockerfile.node22-pw',
  'Dockerfile.node22-pw-pg',
  'Dockerfile.python-node',
  'Dockerfile.python-node-pg',
  'Dockerfile.python312',
];

const daggerBaseTemplates = [
  ['Dockerfile.dotnet9', 'DAGGER_VERSION'],
  ['Dockerfile.dotnet10', 'DAGGER_VERSION'],
  ['Dockerfile.dotnet10-go', 'DAGGER_GO_SDK_VERSION'],
  ['Dockerfile.go124', 'DAGGER_GO_SDK_VERSION'],
  ['Dockerfile.go124-pw', 'DAGGER_GO_SDK_VERSION'],
] as const;

async function readBaseTemplate(filename: string): Promise<string> {
  return readFile(path.join(repoRoot, 'templates/base', filename), 'utf8');
}

async function readScript(filename: string): Promise<string> {
  return readFile(path.join(repoRoot, 'scripts', filename), 'utf8');
}

function extractInitdbWrapper(dockerfile: string): string {
  const match = dockerfile.match(
    /COPY <<'AUTOPOD_INITDB' \/usr\/local\/bin\/initdb\n([\s\S]+?)\nAUTOPOD_INITDB/,
  );
  if (!match?.[1]) throw new Error('node22-pw-pg initdb wrapper is missing');
  return match[1];
}

describe('Trusted Pi worker base image prerequisites', () => {
  it.each(workerBaseTemplates)('%s installs pinned pnpm before using it', async (filename) => {
    const dockerfile = await readBaseTemplate(filename);
    const installIndex = dockerfile.indexOf('npm install -g pnpm@9');
    const workerBuildIndex = dockerfile.indexOf('pnpm --filter @autopod/pi-worker install');

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(workerBuildIndex).toBeGreaterThan(installIndex);
    expect(dockerfile).toContain('command -v pi');
    expect(dockerfile).toContain('$(npm root -g)/@autopod/pi-worker/dist/index.js');
    expect(dockerfile).not.toContain('/usr/local/lib/node_modules/@autopod/pi-worker');
  });
});

describe('Playwright base image templates', () => {
  it.each(playwrightBaseTemplates)(
    '%s exports the browser cache path and verifies Chromium launch',
    async (filename) => {
      const dockerfile = await readBaseTemplate(filename);

      expect(dockerfile).toContain('ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers');
      expect(dockerfile).toContain("const { chromium } = require('playwright')");
      expect(dockerfile).toContain('chromium.launch()');
      expect(dockerfile).toContain('await browser.close()');
      expect(dockerfile).toContain('cannot launch as the runtime user');
    },
  );
});

describe('PostgreSQL base image templates', () => {
  it('configures node22-pw-pg without a volatile runtime socket directory', async () => {
    const dockerfile = await readBaseTemplate('Dockerfile.node22-pw-pg');

    expect(dockerfile).toContain('FROM node:22-slim');
    expect(dockerfile).toContain('postgresql-17');
    expect(dockerfile).toContain('/usr/share/postgresql/17/extension/pgcrypto.control');
    expect(dockerfile).toContain("unix_socket_directories = ''");
    expect(dockerfile).toContain("COPY <<'AUTOPOD_INITDB' /usr/local/bin/initdb");
    expect(dockerfile).toContain('real_initdb=/usr/lib/postgresql/17/bin/initdb');
    expect(dockerfile).not.toContain('/var/run/postgresql');
    expect(dockerfile).toContain('ENV PGDATA=/tmp/pgdata');
    expect(dockerfile).toContain('ENV PGHOST=127.0.0.1');
    expect(dockerfile).toContain('ENV PGPORT=5433');
    expect(dockerfile).toContain('for binary in pg_ctl postgres');
    expect(dockerfile).not.toContain('pip install');
  });

  it('makes every successfully initialized cluster TCP-only', async () => {
    const dockerfile = await readBaseTemplate('Dockerfile.node22-pw-pg');
    const tempDir = await mkdtemp(path.join(tmpdir(), 'autopod-initdb-'));

    try {
      const fakeInitdb = path.join(tempDir, 'real-initdb');
      const wrapperPath = path.join(tempDir, 'initdb');
      const fakeScript = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  echo "initdb (PostgreSQL) test"
  exit 0
fi
pgdata=\${PGDATA:-}
expect_pgdata=0
for arg in "$@"; do
  if [ "$expect_pgdata" -eq 1 ]; then
    pgdata=$arg
    expect_pgdata=0
    continue
  fi
  case "$arg" in
    -D|--pgdata) expect_pgdata=1 ;;
    -D?*) pgdata=\${arg#-D} ;;
    --pgdata=*) pgdata=\${arg#--pgdata=} ;;
    -*) ;;
    *) pgdata=$arg ;;
  esac
done
mkdir -p "$pgdata"
printf "#unix_socket_directories = '/var/run/postgresql'\\n" > "$pgdata/postgresql.conf"
`;
      const wrapper = extractInitdbWrapper(dockerfile).replace(
        'real_initdb=/usr/lib/postgresql/17/bin/initdb',
        `real_initdb=${JSON.stringify(fakeInitdb)}`,
      );
      await writeFile(fakeInitdb, fakeScript);
      await writeFile(wrapperPath, wrapper);
      await chmod(fakeInitdb, 0o755);
      await chmod(wrapperPath, 0o755);
      await expect(execFileAsync(wrapperPath, ['--version'])).resolves.toMatchObject({
        stdout: 'initdb (PostgreSQL) test\n',
      });

      const cases = [
        { args: ['-D', path.join(tempDir, 'short-option')], pgdata: '' },
        { args: [`--pgdata=${path.join(tempDir, 'long-option')}`], pgdata: '' },
        { args: [path.join(tempDir, 'positional')], pgdata: '' },
        { args: [], pgdata: path.join(tempDir, 'environment') },
      ];
      for (const testCase of cases) {
        await execFileAsync(wrapperPath, testCase.args, {
          env: { ...process.env, PGDATA: testCase.pgdata },
        });
        const clusterPath =
          testCase.pgdata || testCase.args.at(-1)?.replace(/^--pgdata=/, '') || '';
        const config = await readFile(path.join(clusterPath, 'postgresql.conf'), 'utf8');
        expect(config).toContain("#unix_socket_directories = '/var/run/postgresql'");
        expect(config.match(/^unix_socket_directories = ''$/gm)).toHaveLength(1);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the Scruffy PostgreSQL smoke on Azure Sandbox and replaces dirty state', async () => {
    const smoke = await readScript('smoke-scruffy-postgres-sandbox.mjs');

    expect(smoke).toContain('SandboxContainerManager.withAzureClient');
    expect(smoke).toContain("const image = requiredEnv('SANDBOX_IMAGE')");
    expect(smoke).toContain('await manager.spawn');
    expect(smoke).toContain('await manager.execInContainer');
    expect(smoke).toContain('test ! -e /var/run/postgresql');
    expect(smoke).toContain('fresh PostgreSQL startup');
    expect(smoke).toContain('initdb -D "$PGDATA" -U scruffy --auth=trust');
    expect(smoke).toContain("rolname = \\'autopod\\'");
    expect(smoke).toContain('pg_ctl -D "$PGDATA" -m fast -w stop');
    expect(smoke).toContain('rm -rf -- "$PGDATA"');
    expect(smoke).toContain('initdb -D "$PGDATA" -U postgres --auth=trust');
    expect(smoke.match(/-l "\$PGDATA\/postgres\.log" -w start/g)).toHaveLength(3);
    expect(smoke).not.toContain('-p 5433" -w start');
    expect(smoke).toContain('createuser -h 127.0.0.1 -p 5433 -U postgres --login scruffy');
    expect(smoke).toContain('createdb -h 127.0.0.1 -p 5433 -U postgres -O scruffy scruffy');
    expect(smoke).toContain('postgresql://scruffy@127.0.0.1:5433/scruffy');
    expect(smoke).toContain('finally {');
    expect(smoke).toContain('await manager.kill(sandboxId)');
    expect(smoke).not.toContain('az acr run');
    expect(smoke).not.toContain('DockerContainerManager');
  });
});

describe('Dagger base image templates', () => {
  it.each(daggerBaseTemplates)(
    '%s pins and verifies the Dagger CLI at v0.20.8',
    async (filename, versionArgument) => {
      const dockerfile = await readBaseTemplate(filename);

      expect(dockerfile).toContain(`ARG ${versionArgument}=v0.20.8`);
      expect(dockerfile).toContain(`DAGGER_VERSION=\${${versionArgument}#v}`);
      expect(dockerfile).toContain(
        `dagger version | grep -Eq "(^|[[:space:]])\${${versionArgument}}([[:space:]]|$)"`,
      );
    },
  );

  it.each(
    daggerBaseTemplates.filter(
      ([, versionArgument]) => versionArgument === 'DAGGER_GO_SDK_VERSION',
    ),
  )('%s keeps the cached Go SDK aligned with the CLI', async (filename, versionArgument) => {
    const dockerfile = await readBaseTemplate(filename);

    expect(dockerfile).toContain(
      `GOSUMDB=sum.golang.org go get dagger.io/dagger@\${${versionArgument}}`,
    );
    const declarations = dockerfile.match(new RegExp(`^ARG ${versionArgument}.*$`, 'gm')) ?? [];
    expect(declarations.length).toBeGreaterThanOrEqual(1);
    expect(declarations.every((line) => line === `ARG ${versionArgument}=v0.20.8`)).toBe(true);
  });
});
