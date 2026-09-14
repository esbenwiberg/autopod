import { type EnvironmentBuildInputs, environmentImageKey } from './environment-image-key.js';

/** Software-only build context: no checkout, repository scripts or credential build arguments. */
export function generateEnvironmentDockerfile(input: EnvironmentBuildInputs): string {
  const key = environmentImageKey(input);
  const commands = [...input.toolInstallCommands, ...input.environment.prepareCommands];
  return [
    `FROM ${input.pinnedBase}`,
    `LABEL com.autopod.environment-key="${key}"`,
    'USER autopod',
    'ENV PATH="/home/autopod/.local/bin:$PATH"',
    'WORKDIR /home/autopod',
    ...commands.map((command) => `RUN ${JSON.stringify(['sh', '-e', '-c', command])}`),
    'WORKDIR /workspace',
    '',
  ].join('\n');
}
