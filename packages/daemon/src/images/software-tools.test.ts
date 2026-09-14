import { describe, expect, it } from 'vitest';
import { softwareToolInstallCommands } from './software-tools.js';

describe('environment software installation', () => {
  it('pins public software and keeps package arguments literal', () => {
    const commands = softwareToolInstallCommands([
      { name: 'pnpm', version: '9.15.0' },
      { name: 'npm:@example/tool', version: '1.2.3' },
      { name: 'playwright', version: '1.50.0' },
      { name: 'pip:serena-agent', version: '1.7.0' },
      { name: 'dotnet:RoslynCodeLens.Mcp', version: '2.18.0' },
    ]);
    expect(commands[0]).toContain("'pnpm@9.15.0'");
    expect(commands[1]).toContain("'@example/tool@1.2.3'");
    expect(commands[2]).toContain('playwright install chromium');
    expect(commands[3]).toContain("'serena-agent==1.7.0'");
    expect(commands[4]).toContain("'RoslynCodeLens.Mcp' --version '2.18.0'");
    expect(() => softwareToolInstallCommands([{ name: 'pnpm', version: 'latest' }])).toThrow(
      'exact',
    );
    expect(() =>
      softwareToolInstallCommands([{ name: 'npm:a;echo secret', version: '1.2.3' }]),
    ).toThrow('Unsupported');
    expect(() =>
      softwareToolInstallCommands([
        { name: 'pnpm', version: '1.2.3' },
        { name: 'pnpm', version: '2.3.4' },
      ]),
    ).toThrow('Duplicate');
  });
});
