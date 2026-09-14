import type {
  ConfigurationCredentialPurpose,
  EffectiveLaunchConfig,
  RepositorySetup,
} from '@autopod/shared';
import { configurationError } from './configuration-store.js';
import type { ConfigurationCredentialStore } from './credential-store.js';

type Value = RepositorySetup['buildEnv'][string];
export interface CredentialUse {
  value: Value;
  purpose: ConfigurationCredentialPurpose;
  destination?: string;
}
/** Walk only typed value/reference fields; never guess from field names such as tokenBudget. */
export function launchCredentialUses(config: EffectiveLaunchConfig): CredentialUse[] {
  const uses: CredentialUse[] = [];
  const values = (
    fields: Record<string, Value>,
    purpose: ConfigurationCredentialPurpose,
    destination?: string,
  ) => {
    for (const value of Object.values(fields))
      uses.push({ value, purpose, ...(destination ? { destination } : {}) });
  };
  if (config.repository) {
    const setup = config.repository.setup;
    values(setup.buildEnv, 'build-env');
    if (setup.integrations.deployment) values(setup.integrations.deployment.env, 'deployment-env');
    for (const registry of setup.integrations.privateRegistries)
      if (registry.credential)
        uses.push({
          value: registry.credential,
          purpose: 'registry-read',
          destination: registry.url,
        });
  }
  for (const pack of config.toolPacks)
    for (const server of pack.mcpServers) {
      if (server.transport.type === 'http')
        values(server.transport.headers, 'mcp-http', server.transport.url);
      else values(server.transport.env, 'mcp-env');
    }
  return uses;
}
export function resolveLaunchCredentialReferences(
  config: EffectiveLaunchConfig,
  store: ConfigurationCredentialStore,
): EffectiveLaunchConfig['credentialReferences'] {
  const references: EffectiveLaunchConfig['credentialReferences'] = {};
  for (const use of launchCredentialUses(config)) {
    if ('value' in use.value) {
      if (
        use.value.value.startsWith('$DAEMON:') ||
        /(?:github_pat_|gh[pousr]_)[a-zA-Z0-9_]+|sk-(?:ant-|proj-)[a-zA-Z0-9_-]+/.test(
          use.value.value,
        )
      )
        configurationError(
          'A credential was placed in a public literal; use an allowed scoped credential reference',
          'CONFIG_SECRET_IN_LITERAL',
          403,
        );
      continue;
    }
    const metadata = store.get(use.value.secretId);
    if (metadata.revoked)
      configurationError('Selected credential was revoked', 'CONFIG_CREDENTIAL_REVOKED', 403);
    if (
      !metadata.purposes.includes(use.purpose) ||
      (use.destination && !metadata.origins.includes(new URL(use.destination).origin))
    )
      configurationError(
        'Selected credential is not allowed for this purpose or service',
        'CONFIG_CREDENTIAL_SCOPE',
        403,
      );
    references[metadata.id] = {
      secretId: metadata.id,
      createdAt: metadata.createdAt,
      purposes: metadata.purposes,
      origins: metadata.origins,
    };
  }
  return references;
}
export async function resolveLaunchValues(
  config: EffectiveLaunchConfig,
  fields: Record<string, Value>,
  purpose: ConfigurationCredentialPurpose,
  store: ConfigurationCredentialStore,
  destination?: string,
): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if ('value' in value) {
      output[name] = value.value;
      continue;
    }
    const reference = config.credentialReferences[value.secretId];
    if (
      !reference ||
      !reference.purposes.includes(purpose) ||
      (destination && !reference.origins.includes(new URL(destination).origin))
    )
      configurationError(
        'Credential reference is absent from the admitted launch scope',
        'CONFIG_CREDENTIAL_SCOPE',
        403,
      );
    output[name] = await store.resolve(
      reference.secretId,
      reference.createdAt,
      purpose,
      destination,
    );
  }
  return output;
}
