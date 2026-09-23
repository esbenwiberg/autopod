import {
  AutopodError,
  type EnvironmentPreset,
  type Profile,
  type ResolvedEnvironment,
} from '@autopod/shared';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { pack as tarPack } from 'tar-stream';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { boundedDockerCall } from '../containers/docker-bounds.js';
import { buildNuGetCredentialEnv } from '../pods/registry-injector.js';
import type { ProfileStore } from '../profiles/index.js';
import type { AcrClient } from './acr-client.js';
import { generateDockerfile, getConfiguredBaseImage } from './dockerfile-generator.js';
import { generateEnvironmentDockerfile } from './environment-dockerfile.js';
import { type EnvironmentBuildInputs, environmentImageKey } from './environment-image-key.js';
import { softwareToolInstallCommands } from './software-tools.js';

const logger = pino({ name: 'autopod' }).child({ component: 'image-builder' });

/** 7 days in ms — images older than this are considered stale. */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface ImageBuildResult {
  tag: string;
  digest: string;
  size: number; // bytes
  buildDuration: number; // seconds
}

export interface ImageBuilderDependencies {
  docker: Dockerode;
  /**
   * Optional Azure Container Registry client. When omitted, the warm image is
   * built into the local Docker daemon only (no push) — useful for local dev
   * where pods run on the same Docker host that builds the image.
   */
  acr: AcrClient | null;
  profileStore: ProfileStore;
}

export class ImageBuilder {
  private docker: Dockerode;
  private acr: AcrClient | null;
  private profileStore: ProfileStore;

  constructor(deps: ImageBuilderDependencies) {
    this.docker = deps.docker;
    this.acr = deps.acr;
    this.profileStore = deps.profileStore;
  }

  /** Read-only preview: resolves the base identity without pulling, building or publishing. */
  async resolveEnvironment(
    environment: EnvironmentPreset,
    target: 'local' | 'sandbox',
  ): Promise<ResolvedEnvironment> {
    const base = environment.baseImage ?? getConfiguredBaseImage(environment.template);
    let pinnedBase: string;
    let platform: ResolvedEnvironment['platform'];
    if (target === 'sandbox') {
      if (!this.acr) throw new Error('Hosted environment images require the configured registry');
      const qualified = this.acr.resolveTag(base);
      const digest = qualified.includes('@sha256:')
        ? qualified.slice(qualified.lastIndexOf('@') + 1)
        : await boundedDockerCall(this.acr.resolveDigest(qualified), {
            label: 'environment-registry-inspect',
            timeoutMs: 15_000,
          });
      const repository = qualified.split('@')[0] ?? '';
      const tagSeparator = repository.lastIndexOf(':');
      pinnedBase = `${tagSeparator > repository.lastIndexOf('/') ? repository.slice(0, tagSeparator) : repository}@${digest}`;
      platform = 'linux/amd64';
    } else {
      const info = await this.inspectLocalBase(base, environment.template);
      if (info.Os !== 'linux' || !['amd64', 'arm64'].includes(info.Architecture))
        throw new Error('The environment base must be a supported Linux image');
      pinnedBase = info.Id;
      platform = `linux/${info.Architecture}` as ResolvedEnvironment['platform'];
    }
    const toolInstallCommands = softwareToolInstallCommands(environment.tools);
    // Agent binaries and bundled extensions are part of the immutable base layer.
    const agentToolingDigest = configurationDigest({ pinnedBase, toolInstallCommands });
    const binding = { pinnedBase, platform, toolInstallCommands, agentToolingDigest };
    return { ...binding, imageKey: environmentImageKey({ environment, ...binding }) };
  }

  /**
   * Inspect the local base, pulling the registry's pinned digest on a miss. A pull only fills the
   * local image cache — nothing is built or published — so preview stays free of launch effects.
   */
  private async inspectLocalBase(
    base: string,
    template: string,
  ): Promise<Dockerode.ImageInspectInfo> {
    const inspect = (reference: string) =>
      boundedDockerCall(this.docker.getImage(reference).inspect(), {
        label: 'environment-base-inspect',
        timeoutMs: 5_000,
      });
    try {
      return await inspect(base);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    if (!this.acr) {
      throw new AutopodError(
        `Environment base image "${base}" for template "${template}" is not present locally; build or pull it, or configure ACR`,
        'ENVIRONMENT_BASE_UNAVAILABLE',
        424,
      );
    }
    let pinned: string;
    try {
      pinned = await boundedDockerCall(this.acr.pullPinned(base), {
        label: 'environment-base-pull',
        timeoutMs: 600_000,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ base, template, reason }, 'Environment base pull failed');
      throw new AutopodError(
        `Environment base image "${base}" for template "${template}" could not be pulled from the registry: ${reason}`,
        'ENVIRONMENT_BASE_UNAVAILABLE',
        424,
      );
    }
    logger.info({ base, pinned }, 'Pulled environment base from registry');
    return inspect(pinned);
  }

  /** Build a warm image for a profile and push it to ACR. */
  async buildWarmImage(
    profile: Profile,
    options: {
      rebuild?: boolean;
      gitPat?: string;
      gitEntraToken?: string;
      registryPat?: string;
    } = {},
  ): Promise<ImageBuildResult> {
    const localTag = `autopod/${profile.name}:latest`;
    const publishedTag = this.acr ? this.acr.resolveTag(localTag) : localTag;
    const timestampTag = `autopod/${profile.name}:${Date.now()}`;

    // Check if warm image exists and isn't stale
    if (!options.rebuild && profile.warmImageTag) {
      const age = this.getImageAge(profile.warmImageBuiltAt);
      if (age < STALE_THRESHOLD_MS) {
        throw new Error(
          `Warm image for "${profile.name}" is still fresh (${Math.floor(age / 86_400_000)}d old). Use --rebuild to force.`,
        );
      }
    }

    logger.info({ profile: profile.name }, 'Building warm image');
    const startTime = Date.now();

    // 1. Resolve and authenticate the base before generating the Dockerfile.
    const baseImage = await this.resolveBaseImage(profile);
    const dockerfile = generateDockerfile({
      profile,
      gitCredentials: options.gitEntraToken ? 'entra-bearer' : options.gitPat ? 'pat' : 'none',
      ...(baseImage ? { baseImage } : {}),
    });

    // 2. Build image from Dockerfile
    const buildArgs: Record<string, string> = {};
    if (options.gitPat) buildArgs.GIT_PAT = options.gitPat;
    if (options.gitEntraToken) buildArgs.GIT_ENTRA_TOKEN = options.gitEntraToken;
    if (options.registryPat) {
      // npm .npmrc still uses REGISTRY_PAT for _authToken
      buildArgs.REGISTRY_PAT = options.registryPat;
      // NuGet uses credential provider via env var
      const nugetEnv = buildNuGetCredentialEnv(profile.privateRegistries, options.registryPat);
      Object.assign(buildArgs, nugetEnv);
    }
    await this.buildFromDockerfile(dockerfile, localTag, buildArgs, {
      platform: this.acr ? 'linux/amd64' : undefined,
    });
    const buildDuration = (Date.now() - startTime) / 1000;

    // 3. Tag with timestamp for rollback
    const image = this.docker.getImage(localTag);
    const [repo = '', tsTag = 'latest'] = timestampTag.split(':');
    await image.tag({ repo, tag: tsTag });

    // 4. Push to ACR (both latest + timestamped) — skipped in local-only mode.
    // In local mode the image stays in the local Docker daemon and the digest
    // is read from the local inspect; pods spawning on the same host pick it
    // up by tag.
    let digest: string;
    if (this.acr) {
      logger.info({ localTag, publishedTag }, 'Pushing warm image to ACR');
      digest = await this.acr.push(localTag);
      await this.acr.push(timestampTag);
    } else {
      logger.info({ tag: localTag }, 'ACR not configured — keeping warm image local-only');
      const localInspect = await image.inspect();
      digest = localInspect.Id ?? '';
    }

    // 5. Get image size
    const inspectInfo = await image.inspect();
    const size = inspectInfo.Size ?? 0;

    // 6. Update profile in database
    this.profileStore.setWarmImage(profile.name, publishedTag, new Date().toISOString());

    logger.info(
      {
        tag: publishedTag,
        localTag,
        sizeMb: Math.floor(size / 1_048_576),
        buildDuration: buildDuration.toFixed(1),
      },
      'Warm image built successfully',
    );

    return { tag: publishedTag, digest, size, buildDuration };
  }

  /** Build reusable software without reading or updating any repository/profile. */
  async buildEnvironmentImage(
    inputs: EnvironmentBuildInputs,
    options: { publish?: boolean } = {},
  ): Promise<ImageBuildResult> {
    if (options.publish && !this.acr) throw new Error('Environment image publication needs ACR');
    const key = environmentImageKey(inputs);
    const localTag = `autopod/environment:${key}`;
    const started = Date.now();
    let cached = false;
    try {
      const info = await this.docker.getImage(localTag).inspect();
      cached = info.Config?.Labels?.['com.autopod.environment-key'] === key;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    if (!cached) {
      await this.buildFromDockerfile(
        generateEnvironmentDockerfile(inputs),
        localTag,
        {},
        {
          platform: inputs.platform,
        },
      );
    }
    const info = await this.docker.getImage(localTag).inspect();
    if (info.Config?.Labels?.['com.autopod.environment-key'] !== key) {
      throw new Error('Built environment image identity does not match its build inputs');
    }
    const published = options.publish && this.acr ? await this.acr.push(localTag) : null;
    const digest = published ?? info.Id;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error('Environment image did not resolve to an immutable digest');
    }
    const registryTag = this.acr?.resolveTag(localTag);
    return {
      tag:
        published && registryTag
          ? `${registryTag.slice(0, registryTag.lastIndexOf(':'))}@${digest}`
          : digest,
      digest,
      size: info.Size ?? 0,
      buildDuration: (Date.now() - started) / 1000,
    };
  }

  private async resolveBaseImage(profile: Profile): Promise<string | undefined> {
    if (!this.acr) return undefined;

    const template = profile.template ?? 'node22';
    const configured = getConfiguredBaseImage(template);
    const qualified = this.acr.resolveTag(configured);
    try {
      return await this.acr.pullPinned(configured);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Unable to resolve ACR base image for template "${template}" (${qualified}): ${reason}`,
        { cause: err },
      );
    }
  }

  /** Check if a profile's warm image is stale. */
  isStale(profile: Profile): boolean {
    if (!profile.warmImageBuiltAt) return true;
    return this.getImageAge(profile.warmImageBuiltAt) > STALE_THRESHOLD_MS;
  }

  private getImageAge(builtAt: string | null): number {
    if (!builtAt) return Number.POSITIVE_INFINITY;
    return Date.now() - new Date(builtAt).getTime();
  }

  private async buildFromDockerfile(
    dockerfileContent: string,
    tag: string,
    buildArgs: Record<string, string> = {},
    options: { platform?: string } = {},
  ): Promise<void> {
    // Create an in-memory tar archive containing just the Dockerfile
    const pack = tarPack();
    pack.entry({ name: 'Dockerfile' }, dockerfileContent);
    pack.finalize();

    const buildStream = await this.docker.buildImage(pack as unknown as NodeJS.ReadableStream, {
      t: tag,
      buildargs: Object.keys(buildArgs).length > 0 ? buildArgs : undefined,
      platform: options.platform,
    });

    // Wait for build to complete
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        buildStream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: { stream?: string; error?: string }) => {
          if (event.stream) {
            logger.debug({ msg: event.stream.trim() });
          }
          if (event.error) {
            reject(new Error(event.error));
          }
        },
      );
    });
  }
}
