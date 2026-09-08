import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AzureBlobArtifactStore, ManagedIdentityBlobTransport } from './artifact-store.js';
import type { ManagedComponentsConfig } from './bootstrap.js';

const bindingSchema = z
  .object({
    issuer: z.string().url().startsWith('https://'),
    audience: z.string().min(1),
    objectId: z.string().min(1),
    installationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  })
  .strict();
const configSchema = z
  .object({
    bindings: z.array(bindingSchema).min(1).max(32),
    blobContainerUrl: z.string().url().startsWith('https://'),
  })
  .strict();
export type ManagedCliConfig = z.infer<typeof configSchema>;
/** Non-secret opt-in only. No execution enablement knob, tokens, or development auth. */
export function parseManagedCliConfig(
  raw: string | undefined,
  devAuth: boolean,
): ManagedCliConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    if (devAuth || Buffer.byteLength(raw) > 16 * 1024) throw new Error('invalid');
    const value = configSchema.parse(JSON.parse(raw));
    const keys = value.bindings.map((b) => JSON.stringify([b.issuer, b.audience, b.objectId]));
    if (new Set(keys).size !== keys.length) throw new Error('ambiguous');
    // Validates endpoint shape without issuing a token or contacting storage.
    new ManagedIdentityBlobTransport(value.blobContainerUrl);
    return value;
  } catch {
    throw new Error('managed-cli-config-invalid');
  }
}

export function composeDarkManagedCli(
  config: ManagedCliConfig | undefined,
  db: Database.Database,
  databasePath: string,
) {
  if (!config) return undefined;
  // This initial composition cannot replace a real runtime for existing delegated attempts.
  const count = db.prepare('SELECT COUNT(*) AS n FROM managed_pods').get() as { n: number };
  if (count.n !== 0) throw new Error('managed-cli-runtime-composition-required');
  const unavailable = async (): Promise<never> => {
    throw new Error('managed-runtime-not-configured');
  };
  const empty = {
    repositories: [],
    identityBindings: [],
    allowedEffects: [],
    network: { profileId: 'managed-cli-dark', destinations: [] },
  };
  const store = new AzureBlobArtifactStore(
    new ManagedIdentityBlobTransport(config.blobContainerUrl),
    async (id) => {
      const row = db
        .prepare('SELECT blob_manifest_name FROM artifact_exports WHERE artifact_id=?')
        .get(id) as { blob_manifest_name: string } | undefined;
      if (!row || !row.blob_manifest_name.endsWith('/manifest.json'))
        throw new Error('artifact-unregistered');
      return row.blob_manifest_name.slice(0, -'/manifest.json'.length);
    },
  );
  const components: ManagedComponentsConfig = {
    db,
    store,
    enabled: false,
    stateRoot: path.join(path.dirname(path.resolve(databasePath)), 'managed'),
    runtime: {
      preflight: unavailable,
      ensure: unavailable,
      observe: unavailable,
      stop: unavailable,
    },
    admission: {
      profiles: new Map(),
      targets: [],
      enforcement: [],
      enrollmentCeiling: empty,
      identityCeiling: empty,
      backendCeiling: empty,
    },
  };
  return { config: components, bindings: config.bindings };
}
