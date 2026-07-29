import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const imageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(imageDir, '../../../..');

const playwrightBaseTemplates = [
  'Dockerfile.node22-pw',
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

describe('Dagger base image templates', () => {
  it.each(daggerBaseTemplates)(
    '%s pins and verifies the Dagger CLI at v0.20.8',
    async (filename, versionArgument) => {
      const dockerfile = await readBaseTemplate(filename);

      expect(dockerfile).toContain(`ARG ${versionArgument}=v0.20.8`);
      expect(dockerfile).toContain(`DAGGER_VERSION=\${${versionArgument}#v}`);
      expect(dockerfile).toContain(`dagger version | grep -q "\${${versionArgument}}"`);
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
