import type { EnvironmentPreset } from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';

/** Public software only. Feed credentials and repository commands belong to pod preparation. */
export function softwareToolInstallCommands(tools: EnvironmentPreset['tools']): string[] {
  const names = new Set<string>();
  return tools.map(({ name, version }) => {
    if (names.has(name)) configurationError(`Duplicate environment tool ${name}`, 'TOOL_CONFLICT');
    names.add(name);
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
      configurationError(`Pin an exact version for ${name}`, 'TOOL_VERSION_REQUIRED');
    const npmName =
      name === 'pnpm' || name === 'playwright'
        ? name
        : name.startsWith('npm:')
          ? name.slice(4)
          : null;
    if (npmName && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(npmName)) {
      const install = `npm install --global --prefix /home/autopod/.local --registry https://registry.npmjs.org '${npmName}@${version}'`;
      return npmName === 'playwright'
        ? `${install} && /home/autopod/.local/bin/playwright install chromium`
        : install;
    }
    if (name.startsWith('pip:') && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name.slice(4)))
      return `python3 -m pip install --user --index-url https://pypi.org/simple '${name.slice(4)}==${version}'`;
    if (name.startsWith('dotnet:') && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name.slice(7)))
      return `dotnet tool install --global '${name.slice(7)}' --version '${version}'`;
    configurationError(
      `Unsupported software tool ${name}. Select a template, pnpm, playwright, npm:package, pip:package or dotnet:package.`,
      'ENVIRONMENT_TOOL_UNSUPPORTED',
    );
  });
}
