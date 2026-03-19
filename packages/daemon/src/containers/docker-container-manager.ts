import { PassThrough, Writable } from 'node:stream';
import Dockerode from 'dockerode';
import * as tar from 'tar-stream';
import type { Logger } from 'pino';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecResult,
  ExecOptions,
  StreamingExecResult,
} from '../interfaces/container-manager.js';

interface DockerContainerManagerOptions {
  docker?: Dockerode;
  logger: Logger;
}

export class DockerContainerManager implements ContainerManager {
  private docker: Dockerode;
  private logger: Logger;

  constructor({ docker, logger }: DockerContainerManagerOptions) {
    this.docker = docker ?? new Dockerode();
    this.logger = logger;
  }

  async spawn(config: ContainerSpawnConfig): Promise<string> {
    const containerName = `autopod-${config.sessionId}`;
    const env = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);

    // Build port bindings and exposed ports
    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, { HostPort: string }[]> = {};
    if (config.ports) {
      for (const p of config.ports) {
        const key = `${p.container}/tcp`;
        exposedPorts[key] = {};
        portBindings[key] = [{ HostPort: String(p.host) }];
      }
    }

    // Build volume binds
    const binds: string[] = [];
    if (config.volumes) {
      for (const v of config.volumes) {
        binds.push(`${v.host}:${v.container}`);
      }
    }

    this.logger.info(
      { containerName, image: config.image, ports: config.ports, volumes: config.volumes },
      'Creating Docker container',
    );

    const container = await this.docker.createContainer({
      Image: config.image,
      name: containerName,
      Env: env,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: '/workspace',
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: binds.length > 0 ? binds : undefined,
        PortBindings: Object.keys(portBindings).length > 0 ? portBindings : undefined,
        AutoRemove: false,
      },
    });

    await container.start();

    this.logger.info({ containerId: container.id, containerName }, 'Docker container started');
    return container.id;
  }

  async kill(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      try {
        await container.stop({ t: 10 });
      } catch (err: unknown) {
        // Swallow "not running" — container may already be stopped
        if (!isExpectedError(err, [304, 404])) {
          throw err;
        }
      }
      try {
        await container.remove({ force: true });
      } catch (err: unknown) {
        // Swallow "not found" — container may already be removed
        if (!isExpectedError(err, [404])) {
          throw err;
        }
      }
      this.logger.info({ containerId }, 'Docker container killed');
    } catch (err: unknown) {
      if (isExpectedError(err, [404])) {
        this.logger.debug({ containerId }, 'Container already gone, nothing to kill');
        return;
      }
      this.logger.error({ containerId, err }, 'Failed to kill Docker container');
      throw err;
    }
  }

  async writeFile(containerId: string, filePath: string, content: string): Promise<void> {
    const container = this.docker.getContainer(containerId);

    // Build a tar archive with the single file
    const pack = tar.pack();
    // Use the full path relative to root so putArchive (extracting at /) places it correctly
    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    pack.entry({ name: normalizedPath, type: 'file' }, content);
    pack.finalize();

    // Collect tar into a Buffer — dockerode putArchive expects a stream or buffer
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      pack.on('data', (chunk: Buffer) => chunks.push(chunk));
      pack.on('end', resolve);
      pack.on('error', reject);
    });
    const tarBuffer = Buffer.concat(chunks);

    await container.putArchive(tarBuffer, { path: '/' });
    this.logger.debug({ containerId, filePath }, 'File written to container');
  }

  async getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      return info.State.Running ? 'running' : 'stopped';
    } catch {
      return 'unknown';
    }
  }

  async execInContainer(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const container = this.docker.getContainer(containerId);

    const execCreateOptions: Dockerode.ExecCreateOptions = {
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      ...(options?.cwd ? { WorkingDir: options.cwd } : {}),
    };

    const exec = await container.exec(execCreateOptions);
    const stream = await exec.start({ hijack: true, stdin: false });

    const { stdout, stderr } = await collectDemuxedOutput(stream, this.docker, options?.timeout);

    const inspection = await exec.inspect();
    const exitCode = inspection.ExitCode ?? 1;

    this.logger.debug({ containerId, command, exitCode }, 'Exec completed');
    return { stdout, stderr, exitCode };
  }

  async execStreaming(
    containerId: string,
    command: string[],
    options?: ExecOptions & { env?: Record<string, string> },
  ): Promise<StreamingExecResult> {
    const container = this.docker.getContainer(containerId);

    const envList = options?.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      ...(options?.cwd ? { WorkingDir: options.cwd } : {}),
      ...(envList ? { Env: envList } : {}),
    });

    const muxStream = await exec.start({ hijack: true, stdin: false });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    // Demux the Docker multiplexed stream into separate stdout/stderr
    this.docker.modem.demuxStream(muxStream, stdoutStream, stderrStream);

    // When the mux stream ends, close both output streams
    (muxStream as NodeJS.ReadableStream & { on: Function }).on('end', () => {
      stdoutStream.end();
      stderrStream.end();
    });
    (muxStream as NodeJS.ReadableStream & { on: Function }).on('error', (err: Error) => {
      stdoutStream.destroy(err);
      stderrStream.destroy(err);
    });

    // Resolve exit code once the stream closes and we can inspect the exec
    const exitCode = new Promise<number>((resolve) => {
      const checkExit = async () => {
        try {
          const inspection = await exec.inspect();
          resolve(inspection.ExitCode ?? 1);
        } catch {
          resolve(1);
        }
      };

      (muxStream as NodeJS.ReadableStream & { on: Function }).on('end', checkExit);
      // If stream errors, also try to get exit code
      (muxStream as NodeJS.ReadableStream & { on: Function }).on('error', checkExit);
    });

    const kill = async () => {
      // Destroy the mux stream to abort the exec
      if ('destroy' in muxStream && typeof (muxStream as any).destroy === 'function') {
        (muxStream as any).destroy();
      }
      stdoutStream.destroy();
      stderrStream.destroy();
    };

    this.logger.info({ containerId, command }, 'Streaming exec started');

    return { stdout: stdoutStream, stderr: stderrStream, exitCode, kill };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Demux a Docker attach stream into separate stdout/stderr strings.
 * Docker multiplexes stdout/stderr over a single stream with an 8-byte header per frame.
 */
function collectDemuxedOutput(
  stream: NodeJS.ReadableStream,
  docker: Dockerode,
  timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stdoutWriter = new Writable({
      write(chunk: Buffer, _encoding, cb) {
        stdoutBuf += chunk.toString('utf-8');
        cb();
      },
    });

    const stderrWriter = new Writable({
      write(chunk: Buffer, _encoding, cb) {
        stderrBuf += chunk.toString('utf-8');
        cb();
      },
    });

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve({ stdout: stdoutBuf, stderr: stderrBuf });
      }
    };

    // Use dockerode's modem demuxer to split stdout/stderr
    docker.modem.demuxStream(stream, stdoutWriter, stderrWriter);

    (stream as NodeJS.ReadableStream & { on: Function }).on('end', () => settle());
    (stream as NodeJS.ReadableStream & { on: Function }).on('error', (err: Error) => settle(err));

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        // Attempt to destroy the stream to abort the exec
        if ('destroy' in stream && typeof (stream as any).destroy === 'function') {
          (stream as any).destroy();
        }
        settle(new Error(`Exec timed out after ${timeout}ms`));
      }, timeout);
    }
  });
}

/**
 * Check if a Docker error matches one of the expected HTTP status codes.
 */
function isExpectedError(err: unknown, statusCodes: number[]): boolean {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    return statusCodes.includes((err as { statusCode: number }).statusCode);
  }
  return false;
}
