import {
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Dockerode from 'dockerode';
import type { Logger } from 'pino';
import * as tar from 'tar-stream';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
} from '../interfaces/container-manager.js';
import {
  DOCKER_CALL_TIMEOUTS,
  DockerCallTimeoutError,
  boundedDockerCall,
} from './docker-bounds.js';
import {
  alignMemoryToPageSize,
  createContainerWithStaleRetry,
  isExpectedDockerError,
} from './docker-helpers.js';

const _dirname = dirname(fileURLToPath(import.meta.url));

// Load seccomp profile once at module init. If missing (e.g., test env), fall back to Docker default.
let SECCOMP_JSON: string | undefined;
try {
  SECCOMP_JSON = readFileSync(join(_dirname, 'seccomp-profile.json'), 'utf-8');
} catch {
  // Seccomp profile file not found — Docker will use its built-in default.
  SECCOMP_JSON = undefined;
}

// Top-level directories that exist in every base image with carefully chosen
// permissions. writeFile() must NOT include these as tar entries — doing so
// overwrites their ownership and mode (e.g. /tmp loses its 1777 sticky bit and
// becomes autopod-owned 0755), which combined with CapDrop=ALL (no
// CAP_DAC_OVERRIDE) prevents root inside the container from writing to them.
const SYSTEM_TOP_LEVEL_DIRS = new Set([
  'tmp',
  'etc',
  'var',
  'proc',
  'sys',
  'dev',
  'run',
  'root',
  'home',
  'usr',
  'bin',
  'sbin',
  'lib',
  'lib64',
  'boot',
  'mnt',
  'media',
  'srv',
  'opt',
]);

const REMOVE_TIMEOUT_RECHECK_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeExtractPath(pathname: string): string {
  return pathname.split('/').filter(Boolean).join('/');
}

function isExcludedPath(relPath: string, excludes?: string[]): boolean {
  if (!excludes?.length) return false;
  const normalizedRel = normalizeExtractPath(relPath);
  const segments = normalizedRel.split('/');
  return excludes.some((exclude) => {
    const normalizedExclude = normalizeExtractPath(exclude);
    if (!normalizedExclude) return false;
    if (!normalizedExclude.includes('/')) {
      return segments.includes(normalizedExclude);
    }
    return normalizedRel === normalizedExclude || normalizedRel.startsWith(`${normalizedExclude}/`);
  });
}

function removeStaleSyncStagingDirs(hostPath: string): void {
  for (const entry of readdirSync(hostPath)) {
    if (entry.startsWith('.autopod-sync-') || entry.startsWith('.autopod-extract-')) {
      rmSync(join(hostPath, entry), { recursive: true, force: true });
    }
  }
}

function archiveEntryRelativePath(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function collectRelativeEntries(
  root: string,
  excludes?: string[],
  skipTopLevel?: string,
): string[] {
  const entries: string[] = [];

  function walk(relativeDir: string): void {
    const absoluteDir = relativeDir ? join(root, relativeDir) : root;
    for (const dirent of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relPath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      const topLevel = relPath.split('/')[0];
      if (topLevel === skipTopLevel || isExcludedPath(relPath, excludes)) {
        continue;
      }
      entries.push(relPath);
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        walk(relPath);
      }
    }
  }

  walk('');
  return entries;
}

function mirrorStagedDirectory(
  stagingPath: string,
  hostPath: string,
  excludes?: string[],
  stagingBase?: string,
): void {
  for (const entry of readdirSync(stagingPath)) {
    cpSync(join(stagingPath, entry), join(hostPath, entry), {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }

  const hostEntries = collectRelativeEntries(hostPath, excludes, stagingBase).sort(
    (a, b) => b.length - a.length,
  );
  for (const relPath of hostEntries) {
    if (!pathExists(join(stagingPath, relPath))) {
      rmSync(join(hostPath, relPath), { recursive: true, force: true });
    }
  }
}

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

  private async isContainerListedAsRunning(containerId: string): Promise<boolean> {
    try {
      const containers = await boundedDockerCall(
        this.docker.listContainers({ all: true, filters: { id: [containerId] } }),
        {
          label: 'container.list (start precheck)',
          timeoutMs: DOCKER_CALL_TIMEOUTS.inspect,
          logger: this.logger,
          containerId,
        },
      );
      return containers.some(
        (container) =>
          (container.Id === containerId ||
            container.Id.startsWith(containerId) ||
            containerId.startsWith(container.Id)) &&
          (container.State === 'running' || container.Status.startsWith('Up ')),
      );
    } catch (err) {
      this.logger.debug(
        { err, containerId },
        'Could not pre-check container running state before start',
      );
      return false;
    }
  }

  private async containerRemovedAfterTimeout(
    container: Dockerode.Container,
    containerId: string,
  ): Promise<boolean> {
    await sleep(REMOVE_TIMEOUT_RECHECK_DELAY_MS);

    try {
      await boundedDockerCall(container.inspect(), {
        label: 'container.inspect (remove-timeout recheck)',
        timeoutMs: DOCKER_CALL_TIMEOUTS.inspect,
        logger: this.logger,
        containerId,
      });
      return false;
    } catch (err: unknown) {
      if (isExpectedDockerError(err, [404])) {
        return true;
      }
      this.logger.warn(
        { containerId, err },
        'Could not confirm container removal after remove timeout',
      );
      return false;
    }
  }

  async spawn(config: ContainerSpawnConfig): Promise<string> {
    const containerName = `autopod-${config.podId}`;
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
        binds.push(`${v.host}:${v.container}${v.readOnly ? ':ro' : ''}`);
      }
    }

    this.logger.info(
      { containerName, image: config.image, ports: config.ports, volumes: config.volumes },
      'Creating Docker container',
    );

    // Build security options: always block privilege escalation; add seccomp if available.
    const securityOpt: string[] = ['no-new-privileges:true'];
    if (SECCOMP_JSON) {
      securityOpt.push(`seccomp=${SECCOMP_JSON}`);
    }

    const alignedMemory = config.memoryBytes
      ? alignMemoryToPageSize(config.memoryBytes)
      : undefined;
    const hostConfig: Record<string, unknown> = {
      Binds: binds.length > 0 ? binds : undefined,
      PortBindings: Object.keys(portBindings).length > 0 ? portBindings : undefined,
      AutoRemove: false,
      // Hard memory cap — prevents OOM kills from taking down the whole Docker VM.
      Memory: alignedMemory,
      // MemorySwap == Memory means the container's swap budget equals its RAM
      // budget (i.e. no extra swap is allocated). Without this cap, Docker
      // defaults to MemorySwap = 2 × Memory and a single heavy build can drain
      // the host's shared swap pool, OOM-killing siblings on tightly-allocated
      // hosts (notably Docker Desktop's small Linux VM).
      MemorySwap: alignedMemory,
      // Hard CPU cap — without it a single pod's `npm install` / build can
      // saturate every host core, and MAX_CONCURRENCY pods at once melt the
      // host. NanoCpus is billionths of a core (e.g. 2e9 == 2 cores). Omitted
      // when undefined (unbounded, the old behaviour).
      NanoCpus: config.nanoCpus,
      // Drop ALL capabilities — re-add only what is needed per use-case.
      CapDrop: ['ALL'],
      SecurityOpt: securityOpt,
    };

    if (config.networkName) {
      hostConfig.NetworkMode = config.networkName;
      // NET_ADMIN: iptables firewall rules.
      // SETGID/SETUID: dnsmasq drops privileges to `nobody` via setgroups +
      // setgid + setuid. Without these caps, dnsmasq exits at startup with
      // "failed to change group-id ...: Operation not permitted" — which makes
      // the firewall script fail (exit 5) and, with fail-closed mode, the pod
      // never spawns. The same caps are in Docker's default capability set;
      // we just have to add them back after CapDrop=ALL.
      hostConfig.CapAdd = ['NET_ADMIN', 'SETGID', 'SETUID'];
      // On Linux, host.docker.internal is not auto-added for custom bridge networks.
      // Inject it so containers can always reach the daemon's MCP endpoint.
      hostConfig.ExtraHosts = ['host.docker.internal:host-gateway'];
    }

    const container = await createContainerWithStaleRetry(
      this.docker,
      {
        Image: config.image,
        name: containerName,
        Env: env,
        Cmd: ['sleep', 'infinity'],
        WorkingDir: '/workspace',
        User: 'autopod',
        ExposedPorts: exposedPorts,
        HostConfig: hostConfig,
      },
      this.logger,
    );

    await boundedDockerCall(container.start(), {
      label: 'container.start (spawn)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.start,
      logger: this.logger,
      containerId: container.id,
    });

    this.logger.info({ containerId: container.id, containerName }, 'Docker container started');

    // Apply firewall rules if provided.
    //
    // Fail-closed by default for `restricted` and `deny-all`: if iptables setup
    // fails, the container would otherwise run with unrestricted egress, which
    // silently turns a network-isolated pod into an open one. Tear down and
    // surface the error instead.
    //
    // `allow-all` always degrades gracefully — there is no isolation to lose.
    // Set `AUTOPOD_FAIL_OPEN_FIREWALL=1` to opt out (e.g. dev hosts without
    // iptables); doing so accepts the egress risk and is logged loudly.
    if (config.firewallScript) {
      const isolationMode =
        config.networkPolicyMode === 'deny-all' || config.networkPolicyMode === 'restricted';
      const failOpen = process.env.AUTOPOD_FAIL_OPEN_FIREWALL === '1';
      const failClosed = isolationMode && !failOpen;
      try {
        await this.refreshFirewall(container.id, config.firewallScript);
      } catch (err) {
        if (failClosed) {
          this.logger.error(
            {
              err,
              containerId: container.id,
              networkPolicyMode: config.networkPolicyMode,
            },
            'Firewall setup failed for isolated pod — aborting spawn (fail-closed)',
          );
          // Tear down the container before surfacing the error so it doesn't leak.
          await boundedDockerCall(this.docker.getContainer(container.id).remove({ force: true }), {
            label: 'container.remove (firewall-fail cleanup)',
            timeoutMs: DOCKER_CALL_TIMEOUTS.remove,
            logger: this.logger,
            containerId: container.id,
          }).catch(() => {});
          throw new Error(
            `Firewall setup failed for ${config.networkPolicyMode} pod — aborting spawn: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const logFn = isolationMode ? this.logger.error : this.logger.warn;
        logFn.call(
          this.logger,
          {
            err,
            containerId: container.id,
            networkPolicyMode: config.networkPolicyMode,
            failOpenOverride: isolationMode && failOpen,
          },
          isolationMode
            ? 'Firewall setup failed but AUTOPOD_FAIL_OPEN_FIREWALL=1 — continuing with NO network isolation'
            : 'Failed to apply firewall rules, continuing without network isolation',
        );
      }
    }

    return container.id;
  }

  async stop(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await boundedDockerCall(container.stop({ t: 10 }), {
        label: 'container.stop',
        timeoutMs: DOCKER_CALL_TIMEOUTS.stop,
        logger: this.logger,
        containerId,
      });
      this.logger.info({ containerId }, 'Docker container stopped');
    } catch (err: unknown) {
      if (isExpectedDockerError(err, [304, 404])) {
        this.logger.debug({ containerId }, 'Container already stopped or removed');
        return;
      }
      this.logger.error({ containerId, err }, 'Failed to stop Docker container');
      throw err;
    }
  }

  async start(containerId: string): Promise<void> {
    try {
      if (await this.isContainerListedAsRunning(containerId)) {
        this.logger.debug({ containerId }, 'Container already running');
        return;
      }

      const container = this.docker.getContainer(containerId);
      await boundedDockerCall(container.start(), {
        label: 'container.start',
        timeoutMs: DOCKER_CALL_TIMEOUTS.start,
        logger: this.logger,
        containerId,
      });
      this.logger.info({ containerId }, 'Docker container started');
    } catch (err: unknown) {
      if (isExpectedDockerError(err, [304])) {
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
        await boundedDockerCall(container.stop({ t: 10 }), {
          label: 'container.stop (kill)',
          timeoutMs: DOCKER_CALL_TIMEOUTS.stop,
          logger: this.logger,
          containerId,
        });
      } catch (err: unknown) {
        if (err instanceof DockerCallTimeoutError) {
          // Stop hung but force-remove can still succeed. Falling through is
          // the whole point of bounding cleanup paths.
          this.logger.warn(
            { containerId },
            'Stop timed out during kill — proceeding to force-remove',
          );
        } else if (!isExpectedDockerError(err, [304, 404])) {
          // Preserve original semantics: an unexpected stop error skips
          // remove and propagates. Callers that rely on this contract see
          // the same behaviour they always have.
          throw err;
        }
      }
      try {
        await boundedDockerCall(container.remove({ force: true }), {
          label: 'container.remove (kill)',
          timeoutMs: DOCKER_CALL_TIMEOUTS.remove,
          logger: this.logger,
          containerId,
        });
      } catch (err: unknown) {
        if (err instanceof DockerCallTimeoutError) {
          if (await this.containerRemovedAfterTimeout(container, containerId)) {
            this.logger.warn(
              { containerId },
              'Remove timed out during kill but follow-up inspect confirmed container is gone',
            );
            return;
          }
          this.logger.error(
            { containerId },
            'Remove timed out during kill — container may leak (daemon wedged)',
          );
          throw err;
        }
        // Swallow "not found" — container may already be removed
        if (!isExpectedDockerError(err, [404])) {
          throw err;
        }
      }
      this.logger.info({ containerId }, 'Docker container killed');
    } catch (err: unknown) {
      if (isExpectedDockerError(err, [404])) {
        this.logger.debug({ containerId }, 'Container already gone, nothing to kill');
        return;
      }
      this.logger.error({ containerId, err }, 'Failed to kill Docker container');
      throw err;
    }
  }

  async writeFile(containerId: string, filePath: string, content: string | Buffer): Promise<void> {
    const container = this.docker.getContainer(containerId);

    // Build a tar archive with the single file, including parent directory entries.
    // uid/gid 1000 = autopod user — without this Docker extracts as root and the
    // process can't create new files in those directories (config updates, pod state).
    //
    // Exception: skip top-level system dirs (/tmp, /etc, ...). They already exist
    // in the base image with carefully chosen permissions (e.g. /tmp is 1777
    // sticky). Re-emitting them as autopod:1000 mode 0755 strips the sticky bit
    // and world-writable permission. Combined with CapDrop=ALL (which removes
    // CAP_DAC_OVERRIDE), root inside the container can no longer write to /tmp,
    // breaking the firewall script that runs as root.
    const pack = tar.pack();
    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    const parts = normalizedPath.split('/');
    // Add each intermediate directory as an explicit entry so they're owned by autopod
    for (let i = 1; i < parts.length; i++) {
      // Top-level system dir — leave it alone (see comment above).
      const firstPart = parts[0];
      if (i === 1 && firstPart !== undefined && SYSTEM_TOP_LEVEL_DIRS.has(firstPart)) continue;
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

    await boundedDockerCall(container.putArchive(tarBuffer, { path: '/' }), {
      label: 'container.putArchive',
      timeoutMs: DOCKER_CALL_TIMEOUTS.putArchive,
      logger: this.logger,
      containerId,
    });
    this.logger.debug({ containerId, filePath }, 'File written to container');
  }

  async readFile(containerId: string, filePath: string): Promise<string> {
    const buf = await this.readFileBinary(containerId, filePath);
    return buf.toString('utf-8');
  }

  async readFileBinary(containerId: string, filePath: string): Promise<Buffer> {
    const container = this.docker.getContainer(containerId);

    // getArchive returns a tar stream of the file/directory at the given path
    const archiveStream = await boundedDockerCall(container.getArchive({ path: filePath }), {
      label: 'container.getArchive (readFileBinary)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.getArchive,
      logger: this.logger,
      containerId,
    });

    // Extract the single file from the tar archive
    const extract = tar.extract();
    const chunks: Buffer[] = [];

    return new Promise<Buffer>((resolve, reject) => {
      extract.on('entry', (_header, stream, next) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', next);
        stream.on('error', reject);
      });
      extract.on('finish', () => {
        resolve(Buffer.concat(chunks));
      });
      extract.on('error', reject);

      (archiveStream as NodeJS.ReadableStream).pipe(extract);
    });
  }

  async extractDirectoryFromContainer(
    containerId: string,
    containerPath: string,
    hostPath: string,
    excludes?: string[],
  ): Promise<void> {
    const container = this.docker.getContainer(containerId);
    // getArchive works on stopped containers — safe to call after container exits
    const archiveStream = await boundedDockerCall(container.getArchive({ path: containerPath }), {
      label: 'container.getArchive (extractDirectoryFromContainer)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.getArchive,
      logger: this.logger,
      containerId,
    });

    mkdirSync(hostPath, { recursive: true });
    removeStaleSyncStagingDirs(hostPath);
    const stagingBase = `.autopod-extract-${process.pid}-${Date.now()}`;
    const stagingPath = join(hostPath, stagingBase);
    mkdirSync(stagingPath, { recursive: true });

    // Tar entries are prefixed with the basename of containerPath (e.g. "workspace/")
    const prefix = `${basename(containerPath)}/`;
    const extract = tar.extract();
    const pendingHardlinks: Array<{ fullPath: string; targetPath: string }> = [];

    try {
      await new Promise<void>((resolve, reject) => {
        extract.on('entry', (header, stream, next) => {
          const rel = archiveEntryRelativePath(header.name, prefix);

          if (!rel) {
            // Root directory entry itself — skip
            stream.resume();
            stream.on('end', next);
            return;
          }

          if (isExcludedPath(rel, excludes)) {
            stream.resume();
            stream.on('end', next);
            return;
          }

          const fullPath = join(stagingPath, rel);

          if (header.type === 'directory') {
            mkdirSync(fullPath, { recursive: true });
            stream.resume();
            stream.on('end', next);
          } else if (header.type === 'symlink') {
            mkdirSync(dirname(fullPath), { recursive: true });
            symlinkSync(header.linkname ?? '', fullPath);
            stream.resume();
            stream.on('end', next);
          } else if (header.type === 'link') {
            mkdirSync(dirname(fullPath), { recursive: true });
            const targetRel = archiveEntryRelativePath(header.linkname ?? '', prefix);
            const targetPath = join(stagingPath, targetRel);
            if (pathExists(targetPath)) {
              linkSync(targetPath, fullPath);
            } else {
              pendingHardlinks.push({ fullPath, targetPath });
            }
            stream.resume();
            stream.on('end', next);
          } else {
            mkdirSync(dirname(fullPath), { recursive: true });
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              try {
                writeFileSync(fullPath, Buffer.concat(chunks));
                next();
              } catch (err) {
                reject(err);
              }
            });
            stream.on('error', reject);
          }
        });
        extract.on('finish', () => {
          try {
            for (const { fullPath, targetPath } of pendingHardlinks) {
              if (!pathExists(targetPath)) {
                this.logger.warn(
                  { fullPath, targetPath },
                  'Skipping archive hardlink with missing target',
                );
                continue;
              }
              linkSync(targetPath, fullPath);
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        extract.on('error', reject);
        (archiveStream as NodeJS.ReadableStream).pipe(extract);
      });

      mirrorStagedDirectory(stagingPath, hostPath, excludes, stagingBase);
    } finally {
      rmSync(stagingPath, { recursive: true, force: true });
    }
  }

  async getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await boundedDockerCall(container.inspect(), {
        label: 'container.inspect (getStatus)',
        timeoutMs: DOCKER_CALL_TIMEOUTS.inspect,
        logger: this.logger,
        containerId,
      });
      return info.State.Running ? 'running' : 'stopped';
    } catch {
      // Includes DockerCallTimeoutError — a wedged daemon looks the same as
      // "container gone" for status-polling purposes; both yield 'unknown'.
      return 'unknown';
    }
  }

  async execInContainer(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const container = this.docker.getContainer(containerId);
    const safeCommand = command.map((a) => (a.length > 1024 ? `<arg: ${a.length} bytes>` : a));

    const envList = options?.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    const execCreateOptions: Dockerode.ExecCreateOptions = {
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      ...(options?.cwd ? { WorkingDir: options.cwd } : {}),
      ...(options?.user ? { User: options.user } : {}),
      ...(envList ? { Env: envList } : {}),
    };

    const exec = await boundedDockerCall(container.exec(execCreateOptions), {
      label: 'container.exec (execInContainer)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.exec,
      logger: this.logger,
      containerId,
    });
    const stream = await boundedDockerCall(exec.start({ hijack: true, stdin: false }), {
      label: 'exec.start (execInContainer)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.execStart,
      logger: this.logger,
      containerId,
    });

    const { stdout, stderr } = await collectDemuxedOutput(stream, this.docker, options?.timeout);

    let exitCode = 1;
    try {
      const inspection = await boundedDockerCall(exec.inspect(), {
        label: 'exec.inspect (execInContainer)',
        timeoutMs: DOCKER_CALL_TIMEOUTS.execInspect,
        logger: this.logger,
        containerId,
      });
      exitCode = inspection.ExitCode ?? 1;
    } catch (err: unknown) {
      if (err instanceof DockerCallTimeoutError) {
        this.logger.warn(
          { containerId, command: safeCommand },
          'exec.inspect timed out — assuming exit code 1',
        );
      } else {
        throw err;
      }
    }

    this.logger.debug({ containerId, command: safeCommand, exitCode }, 'Exec completed');
    return { stdout, stderr, exitCode };
  }

  async execStreaming(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<StreamingExecResult> {
    const container = this.docker.getContainer(containerId);
    const safeCommand = command.map((a) => (a.length > 1024 ? `<arg: ${a.length} bytes>` : a));

    const envList = options?.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    const exec = await boundedDockerCall(
      container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        ...(options?.cwd ? { WorkingDir: options.cwd } : {}),
        ...(envList ? { Env: envList } : {}),
      }),
      {
        label: 'container.exec (execStreaming)',
        timeoutMs: DOCKER_CALL_TIMEOUTS.exec,
        logger: this.logger,
        containerId,
      },
    );

    const muxStream = await boundedDockerCall(exec.start({ hijack: true, stdin: false }), {
      label: 'exec.start (execStreaming)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.execStart,
      logger: this.logger,
      containerId,
    });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdoutWriter = createGuardedDemuxWriter(stdoutStream, 'stdout', {
      containerId,
      command: safeCommand,
      logger: this.logger,
    });
    const stderrWriter = createGuardedDemuxWriter(stderrStream, 'stderr', {
      containerId,
      command: safeCommand,
      logger: this.logger,
    });

    // Demux the Docker multiplexed stream into separate stdout/stderr
    this.docker.modem.demuxStream(muxStream, stdoutWriter, stderrWriter);

    // When the mux stream ends, close both output streams
    (muxStream as NodeJS.ReadableStream & { on: (...args: unknown[]) => unknown }).on('end', () => {
      stdoutWriter.end();
      stderrWriter.end();
      stdoutStream.end();
      stderrStream.end();
    });
    (muxStream as NodeJS.ReadableStream & { on: (...args: unknown[]) => unknown }).on(
      'error',
      (err: Error) => {
        stdoutWriter.destroy(err);
        stderrWriter.destroy(err);
        stdoutStream.destroy(err);
        stderrStream.destroy(err);
      },
    );

    // Resolve exit code once the stream closes and we can inspect the exec.
    // Listen to 'end', 'error', and 'close' — destroy() only emits 'close'.
    // The inspect call is bounded so a wedged daemon can't pin the exit-code
    // promise forever; on timeout we fall back to exit code 1, which the
    // runtime layer's awaitExitCodeBounded then surfaces as a non-fatal error.
    const containerIdForLog = containerId;
    const logger = this.logger;
    const exitCode = new Promise<number>((resolve) => {
      let resolved = false;
      const checkExit = async () => {
        if (resolved) return;
        resolved = true;
        try {
          const inspection = await boundedDockerCall(exec.inspect(), {
            label: 'exec.inspect (execStreaming)',
            timeoutMs: DOCKER_CALL_TIMEOUTS.execInspect,
            logger,
            containerId: containerIdForLog,
          });
          resolve(inspection.ExitCode ?? 1);
        } catch {
          resolve(1);
        }
      };

      const mux = muxStream as NodeJS.ReadableStream & { on: (...args: unknown[]) => unknown };
      mux.on('end', checkExit);
      mux.on('error', checkExit);
      // destroy() emits 'close' but not 'end' — must handle this too
      mux.on('close', checkExit);
    });

    const kill = async () => {
      // Destroy the mux stream to abort the exec
      const destroyable = muxStream as NodeJS.ReadableStream & { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      stdoutStream.destroy();
      stderrStream.destroy();
    };

    this.logger.info({ containerId, command: safeCommand }, 'Streaming exec started');

    return { stdout: stdoutStream, stderr: stderrStream, exitCode, kill };
  }

  async refreshFirewall(containerId: string, script: string): Promise<void> {
    // Write script to container
    await this.writeFile(containerId, '/tmp/firewall.sh', script);

    // Execute as root (iptables requires root)
    const container = this.docker.getContainer(containerId);
    const exec = await boundedDockerCall(
      container.exec({
        Cmd: ['sh', '/tmp/firewall.sh'],
        AttachStdout: true,
        AttachStderr: true,
        User: 'root',
      }),
      {
        label: 'container.exec (refreshFirewall)',
        timeoutMs: DOCKER_CALL_TIMEOUTS.exec,
        logger: this.logger,
        containerId,
      },
    );

    const stream = await boundedDockerCall(exec.start({ hijack: true, stdin: false }), {
      label: 'exec.start (refreshFirewall)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.execStart,
      logger: this.logger,
      containerId,
    });
    const { stdout, stderr } = await collectDemuxedOutput(stream, this.docker, 30_000);

    const inspection = await boundedDockerCall(exec.inspect(), {
      label: 'exec.inspect (refreshFirewall)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.execInspect,
      logger: this.logger,
      containerId,
    });
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

    (stream as NodeJS.ReadableStream & { on: (...args: unknown[]) => unknown }).on('end', () =>
      settle(),
    );
    (stream as NodeJS.ReadableStream & { on: (...args: unknown[]) => unknown }).on(
      'error',
      (err: Error) => settle(err),
    );

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        // Attempt to destroy the stream to abort the exec
        const destroyableStream = stream as NodeJS.ReadableStream & { destroy?: () => void };
        if (typeof destroyableStream.destroy === 'function') {
          destroyableStream.destroy();
        }
        const partialOutput = [stdoutBuf, stderrBuf].filter(Boolean).join('\n').slice(-5_000);
        const err = Object.assign(new Error(`Exec timed out after ${timeout}ms`), {
          partialOutput,
        });
        settle(err);
      }, timeout);
    }
  });
}

interface DemuxWriterContext {
  containerId: string;
  command: string[];
  logger: Logger;
}

function createGuardedDemuxWriter(
  target: PassThrough,
  streamName: 'stdout' | 'stderr',
  context: DemuxWriterContext,
): Writable {
  let loggedDrop = false;

  const logDrop = (err?: Error | null) => {
    if (loggedDrop) return;
    loggedDrop = true;
    context.logger.debug(
      {
        containerId: context.containerId,
        command: context.command,
        err,
        stream: streamName,
      },
      'Dropped Docker demux output after output stream closed',
    );
  };

  target.on('error', (err: Error) => {
    if (isExpectedClosedOutputWrite(err)) {
      logDrop(err);
      return;
    }
    context.logger.warn(
      {
        containerId: context.containerId,
        command: context.command,
        err,
        stream: streamName,
      },
      'Docker demux output stream error',
    );
  });

  const writer = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (target.destroyed || target.writableEnded || target.writableFinished) {
        logDrop();
        callback();
        return;
      }

      target.write(chunk, (err?: Error | null) => {
        if (err) logDrop(err);
        callback();
      });
    },
  });

  writer.on('error', (err: Error) => {
    context.logger.warn(
      {
        containerId: context.containerId,
        command: context.command,
        err,
        stream: streamName,
      },
      'Docker demux writer error',
    );
  });

  return writer;
}

function isExpectedClosedOutputWrite(err: Error): boolean {
  return (
    'code' in err &&
    (err.code === 'ERR_STREAM_WRITE_AFTER_END' || err.code === 'ERR_STREAM_PUSH_AFTER_EOF')
  );
}
