import type { Profile } from '@autopod/shared';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { pack as tarPack } from 'tar-stream';
import { buildNuGetCredentialEnv } from '../pods/registry-injector.js';
import type { ProfileStore } from '../profiles/index.js';
import type { AcrClient } from './acr-client.js';
import { generateDockerfile } from './dockerfile-generator.js';

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
  acr: AcrClient;
  profileStore: ProfileStore;
}

export class ImageBuilder {
  private docker: Dockerode;
  private acr: AcrClient;
  private profileStore: ProfileStore;

  constructor(deps: ImageBuilderDependencies) {
    this.docker = deps.docker;
    this.acr = deps.acr;
    this.profileStore = deps.profileStore;
  }

  /** Build a warm image for a profile and push it to ACR. */
  async buildWarmImage(
    profile: Profile,
    options: { rebuild?: boolean; gitPat?: string; registryPat?: string } = {},
  ): Promise<ImageBuildResult> {
    const tag = `autopod/${profile.name}:latest`;
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

    // 1. Generate Dockerfile
    const dockerfile = generateDockerfile({
      profile,
      gitCredentials: options.gitPat ? 'pat' : 'none',
    });

    // 2. Build image from Dockerfile
    const buildArgs: Record<string, string> = {};
    if (options.gitPat) buildArgs.GIT_PAT = options.gitPat;
    if (options.registryPat) {
      // npm .npmrc still uses REGISTRY_PAT for _authToken
      buildArgs.REGISTRY_PAT = options.registryPat;
      // NuGet uses credential provider via env var
      const nugetEnv = buildNuGetCredentialEnv(profile.privateRegistries, options.registryPat);
      Object.assign(buildArgs, nugetEnv);
    }
    await this.buildFromDockerfile(dockerfile, tag, buildArgs);
    const buildDuration = (Date.now() - startTime) / 1000;

    // 3. Tag with timestamp for rollback
    const image = this.docker.getImage(tag);
    const [repo = '', tsTag = 'latest'] = timestampTag.split(':');
    await image.tag({ repo, tag: tsTag });

    // 4. Push to ACR (both latest + timestamped)
    logger.info({ tag }, 'Pushing to ACR');
    const digest = await this.acr.push(tag);
    await this.acr.push(timestampTag);

    // 5. Get image size
    const inspectInfo = await image.inspect();
    const size = inspectInfo.Size ?? 0;

    // 6. Update profile in database
    this.profileStore.update(profile.name, {
      warmImageTag: tag,
      warmImageBuiltAt: new Date().toISOString(),
    } as Record<string, unknown>);

    logger.info(
      { tag, sizeMb: Math.floor(size / 1_048_576), buildDuration: buildDuration.toFixed(1) },
      'Warm image built successfully',
    );

    return { tag, digest, size, buildDuration };
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
  ): Promise<void> {
    // Create an in-memory tar archive containing just the Dockerfile
    const pack = tarPack();
    pack.entry({ name: 'Dockerfile' }, dockerfileContent);
    pack.finalize();

    const buildStream = await this.docker.buildImage(pack as unknown as NodeJS.ReadableStream, {
      t: tag,
      buildargs: Object.keys(buildArgs).length > 0 ? buildArgs : undefined,
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
