import type { DeploymentConfig, EffectiveLaunchConfig, InjectedMcpServer } from '@autopod/shared';
import {
  NPM_RC_PATH,
  NUGET_CONFIG_PATH,
  type RegistryFile,
  buildNuGetSecretFile,
  generateNpmrc,
  generateNuGetConfig,
} from '../pods/registry-injector.js';
import { configurationError } from './configuration-store.js';
import { resolveLaunchValues } from './credential-references.js';
import type { ConfigurationCredentialStore } from './credential-store.js';

export interface LaunchRegistryMaterial {
  files: RegistryFile[];
  nugetSecret: ReturnType<typeof buildNuGetSecretFile>;
}
export interface LaunchExecutionCredentials {
  agent(
    config: EffectiveLaunchConfig,
  ): Promise<{ buildEnv: Record<string, string>; mcpServers: InjectedMcpServer[] }>;
  buildEnvironment(config: EffectiveLaunchConfig): Promise<Record<string, string>>;
  deployment(config: EffectiveLaunchConfig): Promise<DeploymentConfig | null>;
  httpServer(config: EffectiveLaunchConfig, name: string): Promise<InjectedMcpServer>;
  registries(config: EffectiveLaunchConfig): Promise<LaunchRegistryMaterial>;
}

/** Secrets exist only in the returned execution material, never in a mutated launch snapshot. */
export function createLaunchExecutionCredentials(
  store: ConfigurationCredentialStore,
): LaunchExecutionCredentials {
  async function buildEnvironment(config: EffectiveLaunchConfig) {
    return resolveLaunchValues(config, config.repository?.setup.buildEnv ?? {}, 'build-env', store);
  }
  return {
    buildEnvironment,
    async agent(config) {
      const mcpServers: InjectedMcpServer[] = [];
      for (const server of config.toolPacks.flatMap((pack) => pack.mcpServers)) {
        const transport = server.transport;
        if (transport.type === 'stdio')
          mcpServers.push({
            name: server.name,
            type: 'stdio',
            command: transport.command,
            args: [...transport.args],
            env: await resolveLaunchValues(config, transport.env, 'mcp-env', store),
          });
        // HTTP headers stay daemon-side and are resolved per proxy request.
        else mcpServers.push({ name: server.name, type: 'http', url: transport.url });
      }
      return { buildEnv: await buildEnvironment(config), mcpServers };
    },
    async deployment(config) {
      const deployment = config.repository?.setup.integrations.deployment;
      if (!deployment) return null;
      return {
        ...deployment,
        env: await resolveLaunchValues(config, deployment.env, 'deployment-env', store),
      };
    },
    async httpServer(config, name) {
      const server = config.toolPacks
        .flatMap((pack) => pack.mcpServers)
        .find((entry) => entry.name === name);
      if (!server || server.transport.type !== 'http')
        configurationError('MCP server is outside this launch', 'MCP_SERVER_NOT_FOUND', 404);
      return {
        name,
        type: 'http',
        url: server.transport.url,
        headers: await resolveLaunchValues(
          config,
          server.transport.headers,
          'mcp-http',
          store,
          server.transport.url,
        ),
      };
    },
    async registries(config) {
      const entries = config.repository?.setup.integrations.privateRegistries ?? [];
      const files: RegistryFile[] = [];
      const npm: string[] = [];
      const endpoints: Array<{ endpoint: string; username: string; password: string }> = [];
      for (const registry of entries) {
        if (!registry.credential) continue;
        const values = await resolveLaunchValues(
          config,
          { token: registry.credential },
          'registry-read',
          store,
          registry.url,
        );
        const token = values.token;
        if (!token)
          configurationError(
            'Registry credential is unavailable',
            'CONFIG_CREDENTIAL_REVOKED',
            403,
          );
        if (/[\r\n]/.test(token))
          configurationError(
            'Registry token cannot contain line breaks',
            'CONFIG_CREDENTIAL_INVALID',
            403,
          );
        if (registry.type === 'npm') npm.push(generateNpmrc([registry], token));
        else
          endpoints.push({ endpoint: registry.url, username: 'VssSessionToken', password: token });
      }
      if (npm.length) files.push({ path: NPM_RC_PATH, content: npm.join('\n') });
      const nuget = entries.filter((entry) => entry.type === 'nuget');
      if (nuget.length)
        files.push({ path: NUGET_CONFIG_PATH, content: generateNuGetConfig(nuget) });
      const descriptor = endpoints.length ? buildNuGetSecretFile(nuget, 'descriptor-only') : null;
      const nugetSecret = descriptor
        ? { ...descriptor, content: JSON.stringify({ endpointCredentials: endpoints }) }
        : null;
      return { files, nugetSecret };
    },
  };
}
