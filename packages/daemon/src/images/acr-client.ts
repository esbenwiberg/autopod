import { DefaultAzureCredential } from '@azure/identity';
import { ContainerRegistryClient } from '@azure/container-registry';
import type Dockerode from 'dockerode';
import pino from 'pino';

const logger = pino({ name: 'autopod' }).child({ component: 'acr-client' });

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
    const token = await this.getAccessToken();
    await this.dockerLogin(token);

    // Tag image for ACR
    const acrRepo = `${this.config.registryUrl}/${tag.split(':')[0]}`;
    const acrVersion = tag.split(':')[1] || 'latest';
    const acrTag = `${acrRepo}:${acrVersion}`;

    const image = this.docker.getImage(tag);
    await image.tag({ repo: acrRepo, tag: acrVersion });

    // Push
    const acrImage = this.docker.getImage(acrTag);
    const pushStream = await acrImage.push({
      authconfig: { serveraddress: this.config.registryUrl },
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
    const token = await this.getAccessToken();
    await this.dockerLogin(token);

    const acrTag = `${this.config.registryUrl}/${tag}`;

    const pullStream = await this.docker.pull(acrTag, {
      authconfig: { serveraddress: this.config.registryUrl },
    });

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(pullStream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });

    logger.info({ tag: acrTag }, 'Pulled image from ACR');
  }

  /** Check if an image exists in ACR. */
  async exists(tag: string): Promise<boolean> {
    try {
      const [repo = '', version] = tag.split(':');
      const artifact = this.registryClient.getArtifact(repo, version || 'latest');
      await artifact.getManifestProperties();
      return true;
    } catch {
      return false;
    }
  }

  private async getAccessToken(): Promise<string> {
    const tokenResponse = await this.credential.getToken(
      `https://${this.config.registryUrl}/.default`,
    );
    return tokenResponse.token;
  }

  private async dockerLogin(token: string): Promise<void> {
    await this.docker.checkAuth({
      username: '00000000-0000-0000-0000-000000000000',
      password: token,
      serveraddress: this.config.registryUrl,
    });
  }
}
