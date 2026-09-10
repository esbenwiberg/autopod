import type { Pod, Profile } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';

export interface CommandRequirement {
  source: string;
  executable: string;
}
export interface CommandPreflight {
  requirements: Array<CommandRequirement & { available: boolean | null }>;
  unresolvedSources: string[];
  deferredArtifacts: string[];
  explicitDependencies: boolean;
}

/** Conservative static discovery. Unknown shell structure is explicitly unresolved. */
export function discoverCommandLaunchers(command: string): string[] | null {
  if (command.length > 10000 || /[`$]/.test(command)) return null;
  const segments: string[][] = [[]];
  let word = '';
  let quote = '';
  let escaped = false;
  const finishWord = () => {
    if (word) {
      segments[segments.length - 1]?.push(word);
      word = '';
    }
  };
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      continue;
    }
    if ('(){}<>'.includes(char)) return null;
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (';&|\n'.includes(char)) {
      finishWord();
      if (segments[segments.length - 1]?.length) segments.push([]);
      continue;
    }
    if (/\s/.test(char)) {
      finishWord();
      continue;
    }
    word += char;
  }
  if (quote || escaped) return null;
  finishWord();
  const result: string[] = [];
  for (const words of segments) {
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const executable = words[0];
    if (!executable) continue;
    if (
      [
        'if',
        'then',
        'else',
        'fi',
        'for',
        'while',
        'until',
        'do',
        'done',
        'case',
        'esac',
        'function',
        'eval',
        'cd',
        'exec',
        'env',
      ].includes(executable)
    )
      return null;
    if (
      executable.length > 256 ||
      executable.startsWith('-') ||
      !/^[A-Za-z0-9_./+:-]+$/.test(executable)
    )
      return null;
    result.push(executable);
  }
  return result;
}
export const COMMAND_PREFLIGHT_PROBE = String.raw`
// autopod-command-preflight-v1: fixed read-only argv probe, no repository command execution
const cp = require('node:child_process');
const names=JSON.parse(process.argv[1]); const deadline=Date.now()+10000;
if(!Array.isArray(names)||names.length>64||names.some(name=>typeof name!=='string'||name.length>256||name.startsWith('-'))) process.exit(1);
const results=names.map(executable=> {
  if(Date.now()>deadline) return {executable,available:null};
  const result=cp.spawnSync('sh',['-c','command -v "$1" >/dev/null 2>&1','autopod-command-preflight',executable],{timeout:1000,encoding:'utf8',maxBuffer:1024});
  return {executable,available:result.error||result.signal ? null : result.status===0};
});
process.stdout.write(JSON.stringify(results));
`;
export async function inspectRequiredCommands(
  cm: ContainerManager,
  containerId: string,
  pod: Pod,
  profile: Profile,
): Promise<CommandPreflight> {
  const validationCommands: Array<[string, string | null | undefined]> =
    pod.options?.validate && !pod.skipValidation
      ? [
          ['profile.build', profile.buildCommand],
          ['profile.start', profile.startCommand],
          ['profile.setup', profile.validationSetupCommand],
          ['profile.test', profile.testCommand],
          ['profile.lint', profile.lintCommand],
          ['profile.sast', profile.sastCommand],
        ]
      : [];
  const commands: Array<[string, string | null | undefined]> = [
    ...validationCommands,
    ...(pod.contract?.requiredFacts ?? []).map(
      (fact) => [`fact:${fact.id}`, fact.command] as [string, string],
    ),
  ];
  if (commands.length > 128)
    return {
      requirements: [],
      unresolvedSources: ['command scope exceeds 128 declarations'],
      deferredArtifacts: [],
      explicitDependencies: false,
    };
  const requirements: CommandPreflight['requirements'] = [];
  const unresolvedSources: string[] = [];
  const deferredArtifacts: string[] = [];
  const explicitDependencies = !!pod.contract?.executionRequirements;
  for (const executable of pod.contract?.executionRequirements?.executables ?? [])
    requirements.push({ source: 'contract.executionRequirements', executable, available: null });
  for (const [source, command] of commands) {
    if (!command?.trim()) continue;
    const executables = discoverCommandLaunchers(command);
    if (!executables) {
      unresolvedSources.push(source);
      continue;
    }
    for (const executable of executables) {
      // A declared new script need not exist before the agent creates it.
      if (
        (pod.contract?.requiredFacts ?? []).some(
          (fact) =>
            fact.artifact.change === 'create' &&
            executable.replace(/^\.\//, '') === fact.artifact.path,
        )
      ) {
        deferredArtifacts.push(source);
        continue;
      }
      requirements.push({ source, executable, available: null });
    }
  }
  const names = [...new Set(requirements.map((value) => value.executable))];
  if (names.length > 64)
    return {
      requirements: [],
      deferredArtifacts,
      explicitDependencies: false,
      unresolvedSources: [...unresolvedSources, 'command scope exceeds 64 launchers'],
    };
  if (names.length) {
    try {
      const probe = await cm.execInContainer(
        containerId,
        ['node', '-e', COMMAND_PREFLIGHT_PROBE, JSON.stringify(names)],
        {
          cwd: profile.buildWorkDir ? `/workspace/${profile.buildWorkDir}` : '/workspace',
          timeout: 15000,
          ...(profile.buildEnv ? { env: profile.buildEnv } : {}),
        },
      );
      if (probe.exitCode === 0 && probe.stdout.length <= 65536) {
        const values = JSON.parse(probe.stdout) as unknown;
        if (
          Array.isArray(values) &&
          values.length === names.length &&
          values.every(
            (value, index) =>
              value &&
              value.executable === names[index] &&
              (typeof value.available === 'boolean' || value.available === null),
          )
        ) {
          for (const requirement of requirements)
            requirement.available =
              values.find((value) => value.executable === requirement.executable)?.available ??
              null;
        }
      }
    } catch {
      /* Unavailable never becomes a successful availability check. */
    }
  }
  return { requirements, unresolvedSources, deferredArtifacts, explicitDependencies };
}
