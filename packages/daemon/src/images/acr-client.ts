import { Buffer } from 'node:buffer';
import { ContainerRegistryClient } from '@azure/container-registry';
import { DefaultAzureCredential } from '@azure/identity';
import type Dockerode from 'dockerode';
import pino from 'pino';

const logger = pino({ name: 'autopod' }).child({ component: 'acr-client' });
const ACR_TOKEN_SCOPE = 'https://containerregistry.azure.net/.default';
const ACR_DOCKER_USERNAME = '00000000-0000-0000-0000-000000000000';

export interface AcrConfig {
  registryUrl: string; // e.g. "myregistry.azurecr.io"
}

export class AcrClient {
  private registryClient: ContainerRegistryClient;
  private credential: DefaultAzureCredential;

  constructor(
    private config: AcrConfig,
    private docker: Dockerode,
  ) {
    this.credential = new DefaultAzureCredential();
    this.registryClient = new ContainerRegistryClient(
      `https://${config.registryUrl}`,
      this.credential,
    );
  }

  /** Push a local Docker image to ACR. Returns the image digest. */
  async push(tag: string): Promise<string> {
    const refreshToken = await this.getRegistryRefreshToken();
    const authconfig = this.getDockerAuthConfig(refreshToken);
    await this.docker.checkAuth(authconfig);

    const reference = parseImageReference(tag);
    if (reference.kind === 'digest') {
      throw new Error(`Cannot push immutable image reference: ${tag}`);
    }
    const { version } = reference;
    const acrTag = this.resolveTag(tag);
    const acrRepo = acrTag.slice(0, acrTag.length - `:${version}`.length);

    const image = this.docker.getImage(tag);
    await image.tag({ repo: acrRepo, tag: version });

    // Push
    const acrImage = this.docker.getImage(acrTag);
    const pushStream = await acrImage.push({
      authconfig,
    });

    const digest = await new Promise<string>((resolve, reject) => {
      let lastDigest = '';
      this.docker.modem.followProgress(
        pushStream,
        (err: Error | null) => (err ? reject(err) : resolve(lastDigest)),
        (event: { aux?: { Digest?: string }; error?: string; stream?: string }) => {
          if (event.aux?.Digest) {
            lastDigest = event.aux.Digest;
          }
          if (event.error) {
            reject(new Error(event.error));
          }
        },
      );
    });

    logger.info({ tag: acrTag, digest }, 'Pushed image to ACR');
    return digest;
  }

  /** Pull an image from ACR. */
  async pull(tag: string): Promise<void> {
    const refreshToken = await this.getRegistryRefreshToken();
    const authconfig = this.getDockerAuthConfig(refreshToken);
    await this.docker.checkAuth(authconfig);

    const acrTag = this.resolveTag(tag);

    const pullStream = await this.docker.pull(acrTag, {
      authconfig,
    });

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(pullStream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });

    logger.info({ tag: acrTag }, 'Pulled image from ACR');
  }

  /** Resolve a tag to its digest, then authenticated-pull that exact immutable reference. */
  async pullPinned(tag: string): Promise<string> {
    const qualified = this.resolveTag(tag);
    const reference = parseImageReference(this.stripRegistryPrefix(qualified));
    const pinned =
      reference.kind === 'digest'
        ? qualified
        : `${this.config.registryUrl}/${reference.repo}@${await this.resolveDigest(qualified)}`;
    await this.pull(pinned);
    return pinned;
  }

  /** Credentials for Docker's X-Registry-Config build header. */
  async getBuildRegistryConfig(): Promise<Dockerode.RegistryConfig> {
    const refreshToken = await this.getRegistryRefreshToken();
    return {
      [this.config.registryUrl]: {
        username: ACR_DOCKER_USERNAME,
        password: refreshToken,
      },
    };
  }

  /** Whether this ACR client owns the fully-qualified image reference. */
  canPull(tag: string): boolean {
    return tag.startsWith(`${this.config.registryUrl}/`);
  }

  /** Check if an image exists in ACR. */
  async exists(tag: string): Promise<boolean> {
    try {
      const { repo, version } = parseImageReference(this.stripRegistryPrefix(tag));
      const artifact = this.registryClient.getArtifact(repo, version || 'latest');
      await artifact.getManifestProperties();
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve the current manifest digest for an ACR image reference. */
  async resolveDigest(tag: string): Promise<string> {
    const { repo, version } = parseImageReference(this.stripRegistryPrefix(tag));
    const artifact = this.registryClient.getArtifact(repo, version || 'latest');
    const properties = await artifact.getManifestProperties();
    const digest = (properties as { digest?: unknown }).digest;
    if (typeof digest !== 'string' || digest.length === 0) {
      throw new Error(`ACR manifest for ${tag} did not include a digest`);
    }
    return digest;
  }

  private async getRegistryRefreshToken(): Promise<string> {
    const tokenResponse = await this.credential.getToken(ACR_TOKEN_SCOPE);
    const form = new URLSearchParams({
      grant_type: 'access_token',
      service: this.config.registryUrl,
      access_token: tokenResponse.token,
    });
    const tenantId = extractTenantId(tokenResponse.token);
    if (tenantId) {
      form.set('tenant', tenantId);
    }

    const response = await fetch(`https://${this.config.registryUrl}/oauth2/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `ACR token exchange failed (${response.status} ${response.statusText}): ${body.slice(
          0,
          300,
        )}`,
      );
    }

    const body = (await response.json()) as { refresh_token?: unknown };
    if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
      throw new Error('ACR token exchange did not return a refresh token');
    }
    return body.refresh_token;
  }

  private getDockerAuthConfig(refreshToken: string): Dockerode.AuthConfig {
    return {
      username: ACR_DOCKER_USERNAME,
      password: refreshToken,
      serveraddress: this.config.registryUrl,
    };
  }

  /** Resolve a local image reference to an ACR-qualified tag or digest. */
  resolveTag(tag: string): string {
    const stripped = this.stripRegistryPrefix(tag);
    const { repo, version, kind } = parseImageReference(stripped);
    const separator = kind === 'digest' ? '@' : ':';
    return `${this.config.registryUrl}/${repo}${separator}${version}`;
  }

  private stripRegistryPrefix(tag: string): string {
    const prefix = `${this.config.registryUrl}/`;
    return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  }
}

interface ParsedImageReference {
  repo: string;
  version: string;
  kind: 'tag' | 'digest';
}

function parseImageReference(image: string): ParsedImageReference {
  const lastSlash = image.lastIndexOf('/');
  const digestSeparator = image.lastIndexOf('@');
  if (digestSeparator > lastSlash) {
    const digest = image.slice(digestSeparator + 1);
    if (!digest) throw new Error(`Invalid image digest reference: ${image}`);
    return { repo: image.slice(0, digestSeparator), version: digest, kind: 'digest' };
  }

  const tagSeparator = image.lastIndexOf(':');
  if (tagSeparator > lastSlash) {
    return {
      repo: image.slice(0, tagSeparator),
      version: image.slice(tagSeparator + 1) || 'latest',
      kind: 'tag',
    };
  }
  return { repo: image, version: 'latest', kind: 'tag' };
}

function extractTenantId(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      tid?: unknown;
    };
    return typeof decoded.tid === 'string' ? decoded.tid : undefined;
  } catch {
    return undefined;
  }
}
