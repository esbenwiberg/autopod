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
