import { PassThrough, Readable, Writable } from 'node:stream';
import Dockerode from 'dockerode';
import type { Logger } from 'pino';
import * as tar from 'tar-stream';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
  TtyExecResult,
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

    // Network isolation: attach to named network + add NET_ADMIN for iptables
    const hostConfig: Record<string, unknown> = {
      Binds: binds.length > 0 ? binds : undefined,
      PortBindings: Object.keys(portBindings).length > 0 ? portBindings : undefined,
      AutoRemove: false,
      // Hard memory cap — prevents OOM kills from taking down the whole Docker VM.
      // Docker requires Memory to be a multiple of the system's page size (4096 bytes).
      Memory: config.memoryBytes ? Math.ceil(config.memoryBytes / 4096) * 4096 : undefined,
    };

    if (config.networkName) {
      hostConfig.NetworkMode = config.networkName;
      // NET_ADMIN required for iptables firewall rules inside the container
      hostConfig.CapAdd = ['NET_ADMIN'];
      // On Linux, host.docker.internal is not auto-added for custom bridge networks.
      // Inject it so containers can always reach the daemon's MCP endpoint.
      hostConfig.ExtraHosts = ['host.docker.internal:host-gateway'];
    }

    const container = await this.docker.createContainer({
      Image: config.image,
      name: containerName,
      Env: env,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: '/workspace',
      User: 'autopod',
      ExposedPorts: exposedPorts,
      HostConfig: hostConfig,
    });

    await container.start();

    this.logger.info({ containerId: container.id, containerName }, 'Docker container started');

    // Apply firewall rules if provided
    if (config.firewallScript) {
      try {
        await this.refreshFirewall(container.id, config.firewallScript);
      } catch (err) {
        // Graceful degradation — log warning but don't fail the spawn
        this.logger.warn(
          { err, containerId: container.id },
          'Failed to apply firewall rules, continuing without network isolation',
        );
      }
    }

    return container.id;
  }

  async stop(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 10 });
      this.logger.info({ containerId }, 'Docker container stopped');
    } catch (err: unknown) {
      if (isExpectedError(err, [304])) {
        this.logger.debug({ containerId }, 'Container already stopped');
        return;
      }
      this.logger.error({ containerId, err }, 'Failed to stop Docker container');
      throw err;
    }
  }

  async start(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.start();
      this.logger.info({ containerId }, 'Docker container started');
    } catch (err: unknown) {
      if (isExpectedError(err, [304])) {
        this.logger.debug({ containerId }, 'Container already running');
        return;
      }
      this.logger.error({ containerId, err }, 'Failed to start Docker container');
      throw err;
    }
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

    // Build a tar archive with the single file, including parent directory entries.
    // uid/gid 1000 = autopod user — without this Docker extracts as root and the
    // process can't create new files in those directories (config updates, session state).
    const pack = tar.pack();
    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    const parts = normalizedPath.split('/');
    // Add each intermediate directory as an explicit entry so they're owned by autopod
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/');
      pack.entry({ name: dirPath, type: 'directory', uid: 1000, gid: 1000, mode: 0o755 });
    }
    pack.entry({ name: normalizedPath, type: 'file', uid: 1000, gid: 1000, mode: 0o644 }, content);
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

  async readFile(containerId: string, filePath: string): Promise<string> {
    const container = this.docker.getContainer(containerId);

    // getArchive returns a tar stream of the file/directory at the given path
    const archiveStream = await container.getArchive({ path: filePath });

    // Extract the single file from the tar archive
    const extract = tar.extract();
    const chunks: Buffer[] = [];

    return new Promise<string>((resolve, reject) => {
      extract.on('entry', (_header, stream, next) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', next);
        stream.on('error', reject);
      });
      extract.on('finish', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      extract.on('error', reject);

      (archiveStream as NodeJS.ReadableStream).pipe(extract);
    });
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

    // Resolve exit code once the stream closes and we can inspect the exec.
    // Listen to 'end', 'error', and 'close' — destroy() only emits 'close'.
    const exitCode = new Promise<number>((resolve) => {
      let resolved = false;
      const checkExit = async () => {
        if (resolved) return;
        resolved = true;
        try {
          const inspection = await exec.inspect();
          resolve(inspection.ExitCode ?? 1);
        } catch {
          resolve(1);
        }
      };

      const mux = muxStream as NodeJS.ReadableStream & { on: Function };
      mux.on('end', checkExit);
      mux.on('error', checkExit);
      // destroy() emits 'close' but not 'end' — must handle this too
      mux.on('close', checkExit);
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

  async execTty(
    containerId: string,
    command: string[],
    options?: { cols?: number; rows?: number },
  ): Promise<TtyExecResult> {
    const container = this.docker.getContainer(containerId);

    const exec = await container.exec({
      Cmd: command,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    // With Tty: true Docker gives a raw duplex stream (no 8-byte header framing).
    // We can read from it for output and write to it for stdin.
    const stream = (await exec.start({ hijack: true, stdin: true })) as NodeJS.ReadWriteStream;

    if (options?.cols && options?.rows) {
      await exec.resize({ h: options.rows, w: options.cols }).catch(() => {});
    }

    const exitCode = new Promise<number>((resolve) => {
      let resolved = false;
      const check = async () => {
        if (resolved) return;
        resolved = true;
        try {
          const info = await exec.inspect();
          resolve(info.ExitCode ?? 0);
        } catch {
          resolve(0);
        }
      };
      (stream as NodeJS.ReadableStream & { on: Function }).on('end', check);
      (stream as NodeJS.ReadableStream & { on: Function }).on('close', check);
      (stream as NodeJS.ReadableStream & { on: Function }).on('error', check);
    });

    this.logger.info({ containerId, command }, 'TTY exec started');

    return {
      output: stream as unknown as Readable,
      write: (data: Buffer | string) => {
        (stream as NodeJS.WritableStream).write(data);
      },
      resize: async (cols: number, rows: number) => {
        await exec.resize({ h: rows, w: cols }).catch(() => {});
      },
      kill: async () => {
        (stream as any).destroy?.();
      },
      exitCode,
    };
  }

  async refreshFirewall(containerId: string, script: string): Promise<void> {
    // Write script to container
    await this.writeFile(containerId, '/tmp/firewall.sh', script);

    // Execute as root (iptables requires root)
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ['sh', '/tmp/firewall.sh'],
      AttachStdout: true,
      AttachStderr: true,
      User: 'root',
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const { stdout, stderr } = await collectDemuxedOutput(stream, this.docker, 30_000);

    const inspection = await exec.inspect();
    if (inspection.ExitCode !== 0) {
      this.logger.warn(
        { exitCode: inspection.ExitCode, stderr, stdout },
        'Firewall script exited with non-zero code',
      );
      throw new Error(`Firewall script failed with exit code ${inspection.ExitCode}`);
    }

    this.logger.info({ containerId, stdout: stdout.trim() }, 'Firewall rules applied');
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
