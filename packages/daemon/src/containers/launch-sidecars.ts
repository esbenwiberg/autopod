import {
  DAGGER_RUNNER_HOST_ENV,
  type EffectiveLaunchConfig,
  type SidecarSpec,
} from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';

/** Secrets are supplied at provisioning and never written into the launch snapshot. */
export function launchSidecarSpec(
  config: EffectiveLaunchConfig,
  id: string,
  password?: string,
): { spec: SidecarSpec; podEnv: Record<string, string> } {
  const definition = config.environment.sidecars.find((s) => s.id === id);
  const resources = config.resolvedExecution.sidecars[id];
  if (!definition || !resources || config.resolvedExecution.target !== 'local')
    configurationError('Sidecar was not admitted in this launch', 'SIDECAR_UNAVAILABLE');
  if (resources.cpus === null) configurationError('Docker sidecars require an explicit CPU limit');
  const spec: SidecarSpec = {
    type: definition.type,
    name: id,
    image: definition.image,
    healthCheck: { port: definition.port, timeoutMs: definition.healthTimeoutMs, intervalMs: 500 },
    resources: {
      memoryMb: resources.memoryGb * 1024,
      cpus: resources.cpus,
      pidsLimit: definition.type === 'dagger-engine' ? 4096 : 256,
      ...(resources.storageGb === null ? {} : { storageMb: resources.storageGb * 1024 }),
    },
  };
  const port = definition.port;
  if (definition.type === 'dagger-engine') {
    spec.privileged = true;
    spec.command = [
      '--addr',
      `tcp://0.0.0.0:${port}`,
      '--addr',
      'unix:///run/buildkit/buildkitd.sock',
    ];
    return { spec, podEnv: { [DAGGER_RUNNER_HOST_ENV]: `tcp://${id}:${port}` } };
  }
  if (!password || password.length < 24 || /[\r\n\0]/.test(password))
    configurationError(
      'An ephemeral sidecar credential is required',
      'SIDECAR_CREDENTIAL_REQUIRED',
    );
  const envName = `AUTOPOD_SIDECAR_${id.replaceAll('-', '_').toUpperCase()}_URL`;
  if (definition.type === 'postgres') {
    spec.env = { POSTGRES_USER: 'autopod', POSTGRES_DB: 'autopod', POSTGRES_PASSWORD: password };
    spec.command = ['postgres', '-p', String(port)];
    spec.healthCheck.command = [
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      'autopod',
      '-d',
      'autopod',
      '-t',
      '2',
    ];
    return {
      spec,
      podEnv: {
        [envName]: `postgresql://autopod:${encodeURIComponent(password)}@${id}:${port}/autopod`,
      },
    };
  }
  spec.env = { REDISCLI_AUTH: password };
  spec.command = [
    'sh',
    '-c',
    `exec redis-server --port ${port} --requirepass "$REDISCLI_AUTH" --save '' --appendonly no`,
  ];
  spec.healthCheck.command = [
    'sh',
    '-c',
    `test "$(redis-cli -h 127.0.0.1 -p ${port} --raw ping)" = PONG`,
  ];
  return {
    spec,
    podEnv: { [envName]: `redis://:${encodeURIComponent(password)}@${id}:${port}/0` },
  };
}
