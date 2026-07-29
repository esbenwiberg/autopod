import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const imageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(imageDir, '../../../..');

const playwrightBaseTemplates = [
  'Dockerfile.node22-pw',
  'Dockerfile.node22-pw-pg',
  'Dockerfile.go124-pw',
  'Dockerfile.python-node-pg',
  'Dockerfile.dotnet10',
  'Dockerfile.dotnet10-go',
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
  it('keeps node22-pw-pg on the Node base while adding a non-root transient server', async () => {
    const dockerfile = await readBaseTemplate('Dockerfile.node22-pw-pg');

    expect(dockerfile).toContain('FROM node:22-slim');
    expect(dockerfile).toContain('postgresql-17');
    expect(dockerfile).toContain('/usr/share/postgresql/17/extension/pgcrypto.control');
    expect(dockerfile).toContain('install -d -o autopod -g autopod -m 0755 /var/run/postgresql');
    expect(dockerfile).toContain('ENV PGDATA=/tmp/pgdata');
    expect(dockerfile).toContain('ENV PGHOST=127.0.0.1');
    expect(dockerfile).toContain('ENV PGPORT=5433');
    expect(dockerfile).toContain('for binary in initdb pg_ctl postgres');
    expect(dockerfile).not.toContain('pip install');
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

    expect(dockerfile).toContain(`go get dagger.io/dagger@\${${versionArgument}}`);
  });
});
