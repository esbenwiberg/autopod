import { createHash } from 'node:crypto';
import type { NativeGoalProcessIdentity } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import { DockerContainerManager } from '../containers/docker-container-manager.js';

export interface IsolatedDeploymentInput {
  runId: string;
  sourceTar: Buffer;
  sourceDigest: string;
  scriptPath: string;
  args: string[];
  env: Record<string, string>;
  assertCurrent(): void;
  recordContainer(containerId: string): void;
  recordExec(identity: NativeGoalProcessIdentity): void;
}
export interface DeploymentRunnerResult {
  exitCode: number;
  outputBytes: number;
  containerRemoved: true;
}
/** One disposable daemon-owned runner. The agent receives a receipt, never script output. */
export class IsolatedDeployRunner {
  private readonly manager: DockerContainerManager;
  constructor(
    private readonly options: {
      docker: Dockerode;
      logger: Logger;
      image: string;
      memoryBytes: number;
      cpus: number;
      timeoutMs: number;
      allowedEnv: readonly string[];
      /** Only an independently enforced deployment network may be supplied. Default has no network. */
      network?: {
        create(
          runId: string,
        ): Promise<{ name: string; configure(containerId: string): Promise<void> }>;
        destroy(name: string): Promise<void>;
      };
    },
  ) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(options.image))
      throw new Error('Deployment image must be pinned by digest');
    if (
      !Number.isSafeInteger(options.memoryBytes) ||
      options.memoryBytes < 64 * 1024 * 1024 ||
      options.memoryBytes > 16 * 1024 ** 3 ||
      !Number.isFinite(options.cpus) ||
      options.cpus <= 0 ||
      options.cpus > 16 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 15 * 60 * 1000
    )
      throw new Error('Deployment resource limits are invalid');
    this.manager = new DockerContainerManager({ docker: options.docker, logger: options.logger });
  }
  async run(raw: IsolatedDeploymentInput): Promise<DeploymentRunnerResult> {
    const input = {
      ...raw,
      sourceTar: Buffer.from(raw.sourceTar),
      args: [...raw.args],
      env: { ...raw.env },
    };
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.runId))
      throw new Error('Invalid deployment run identity');
    if (
      !/^[a-f0-9]{64}$/.test(input.sourceDigest) ||
      createHash('sha256').update(input.sourceTar).digest('hex') !== input.sourceDigest
    )
      throw new Error('Deployment source digest changed');
    if (input.sourceTar.length > 128 * 1024 * 1024)
      throw new Error('Deployment source is too large');
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(input.scriptPath) ||
      input.scriptPath.split('/').some((p) => p === '.' || p === '..')
    )
      throw new Error('Invalid deployment script path');
    if (input.args.length > 64 || input.args.some((arg) => arg.length > 4096 || arg.includes('\0')))
      throw new Error('Invalid deployment arguments');
    const forbidden =
      /^(?:PATH|HOME|USER|SHELL|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|IFS|NODE_OPTIONS|PYTHONPATH|LD_.*|DYLD_.*)$/;
    for (const [key, value] of Object.entries(input.env))
      if (
        !/^[A-Z_][A-Z0-9_]*$/.test(key) ||
        forbidden.test(key) ||
        !this.options.allowedEnv.includes(key) ||
        value.includes('\0')
      )
        throw new Error('Deployment environment is outside the runner allowlist');
    // Validate archive members before any container/network allocation. Repack separately at source preparation.
    await validateDeploymentArchive(input.sourceTar, input.scriptPath);
    input.assertCurrent();
    await this.options.docker.getImage(this.options.image).inspect(); // Never pull an unreviewed image implicitly.
    const network = await this.options.network?.create(input.runId);
    let container: Dockerode.Container | undefined;
    let result: Omit<DeploymentRunnerResult, 'containerRemoved'> | undefined;
    try {
      input.assertCurrent();
      container = await this.options.docker.createContainer({
        Image: this.options.image,
        User: '1000:1000',
        WorkingDir: '/workspace',
        Entrypoint: ['/bin/sh', '-c'],
        Cmd: ['exec sleep infinity'],
        Env: [
          'HOME=/tmp/deploy-home',
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ],
        Labels: { 'autopod.deployment-run': input.runId },
        HostConfig: {
          NetworkMode: network?.name ?? 'none',
          CapDrop: ['ALL'],
          // Used only by daemon root bootstrap before source/secrets are copied. The script
          // runs as UID 1000 with no effective capabilities and no privilege escalation.
          ...(network ? { CapAdd: ['NET_ADMIN', 'SETGID', 'SETUID'] } : {}),
          SecurityOpt: ['no-new-privileges'],
          Privileged: false,
          Memory: this.options.memoryBytes,
          MemorySwap: this.options.memoryBytes,
          NanoCpus: Math.round(this.options.cpus * 1e9),
          PidsLimit: 256,
          AutoRemove: false,
        },
      });
      input.recordContainer(container.id);
      input.assertCurrent();
      await container.start();
      await network?.configure(container.id);
      input.assertCurrent();
      const preparation = await this.manager.execInContainer(
        container.id,
        [
          'sh',
          '-c',
          'mkdir -p /workspace /tmp/deploy-home && chmod 0777 /workspace /tmp/deploy-home',
        ],
        { user: 'root', timeout: 5000 },
      );
      if (preparation.exitCode !== 0) throw new Error('Deployment workspace preparation failed');
      await container.putArchive(input.sourceTar, { path: '/workspace' });
      const session = await this.manager.execStreaming(
        container.id,
        ['/bin/bash', '--noprofile', '--norc', `/workspace/${input.scriptPath}`, ...input.args],
        {
          cwd: '/workspace',
          user: '1000:1000',
          env: { ...input.env, HOME: '/tmp/deploy-home' },
          onProcessCreated(identity) {
            input.assertCurrent();
            input.recordExec(identity);
          },
          onProcessStarted() {
            input.assertCurrent();
          },
        },
      );
      let outputBytes = 0;
      // Drain without retaining or exposing output. A trusted deployment script may print a credential.
      session.stdout.on('data', (chunk: Buffer | string) => {
        outputBytes += Buffer.byteLength(chunk);
      });
      session.stderr.on('data', (chunk: Buffer | string) => {
        outputBytes += Buffer.byteLength(chunk);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancellation: ReturnType<typeof setInterval> | undefined;
      try {
        const exitCode = await Promise.race([
          session.exitCode,
          new Promise<never>((_, reject) => {
            cancellation = setInterval(() => {
              try {
                input.assertCurrent();
              } catch {
                reject(new Error('Deployment authorization was revoked'));
              }
            }, 250);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Deployment execution deadline exceeded')),
              this.options.timeoutMs,
            );
          }),
        ]);
        if (!Number.isSafeInteger(exitCode)) throw new Error('Deployment exit is unconfirmed');
        result = { exitCode, outputBytes };
      } finally {
        if (timer) clearTimeout(timer);
        if (cancellation) clearInterval(cancellation);
      }
    } finally {
      // Removing the exact container also stops all children and makes late exec starts impossible.
      // A removal failure intentionally prevents a successful receipt and retains the durable claim.
      if (container) await container.remove({ force: true, v: true });
      if (network) await this.options.network?.destroy(network.name);
    }
    if (!result) throw new Error('Deployment did not produce an exit receipt');
    return { ...result, containerRemoved: true };
  }
}

async function validateDeploymentArchive(archive: Buffer, scriptPath: string): Promise<void> {
  const { extract } = await import('tar-stream');
  const reader = extract();
  let scriptFound = false;
  const seen = new Set<string>();
  const complete = new Promise<void>((resolve, reject) => {
    reader.on('finish', resolve);
    reader.on('error', reject);
  });
  reader.on('entry', (header, stream, next) => {
    const path = header.name.replace(/\/$/, '');
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((p) => p === '..' || p === '.' || p === '.git') ||
      seen.has(path) ||
      !['file', 'directory'].includes(header.type ?? 'file') ||
      header.uid !== 1000 ||
      header.gid !== 1000 ||
      ((header.mode ?? 0) & 0o7000) !== 0
    ) {
      stream.resume();
      reader.destroy(new Error('Deployment archive contains an unsafe member'));
      return;
    }
    seen.add(path);
    if (path === scriptPath && header.type === 'file') scriptFound = true;
    stream.on('end', next);
    stream.resume();
  });
  reader.end(archive);
  await complete;
  if (!scriptFound) throw new Error('Approved deployment script is absent from source');
}
