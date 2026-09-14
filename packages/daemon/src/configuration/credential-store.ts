import { randomUUID } from 'node:crypto';
import {
  type ConfigurationCredential,
  type ConfigurationCredentialPurpose,
  configurationIdSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { CredentialsCipher } from '../crypto/credentials-cipher.js';
import { configurationError } from './configuration-store.js';

const purpose = z.enum(['registry-read', 'mcp-http', 'mcp-env', 'build-env', 'deployment-env']);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  });
const inputSchema = z
  .object({
    id: configurationIdSchema.optional(),
    name: z.string().trim().min(1).max(128),
    purposes: z.array(purpose).min(1).max(5),
    origins: z.array(origin).max(128),
    value: z.string().min(1).max(100_000),
  })
  .strict();
interface Row {
  id: string;
  name: string;
  purposes: string;
  origins: string;
  encrypted_value: string;
  revision: number;
  revoked: number;
  created_at: string;
  updated_at: string;
}
function project(row: Row): ConfigurationCredential {
  return {
    id: row.id,
    name: row.name,
    purposes: z.array(purpose).parse(JSON.parse(row.purposes)),
    origins: z.array(origin).parse(JSON.parse(row.origins)),
    revision: row.revision,
    revoked: !!row.revoked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function createConfigurationCredentialStore(
  db: Database.Database,
  cipher: CredentialsCipher,
  assertServiceCredential: (
    value: string,
    purposes: ConfigurationCredentialPurpose[],
    origins: string[],
  ) => Promise<void>,
) {
  function row(id: string): Row {
    const value = db.prepare('SELECT * FROM configuration_credentials WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!value)
      configurationError('Credential reference is missing', 'CONFIG_CREDENTIAL_MISSING', 404);
    return value;
  }
  async function verify(
    value: string,
    purposes: ConfigurationCredentialPurpose[],
    origins: string[],
  ) {
    // GitHub source credentials remain entirely in the daemon's dedicated GitHub authority.
    if (/(?:github_pat_|gh[pousr]_)[a-zA-Z0-9_]+/.test(value))
      configurationError(
        'GitHub credentials cannot be injected into pods; use scoped GitHub access',
        'SOURCE_CREDENTIAL_FORBIDDEN',
        403,
      );
    if (origins.some((value) => ['github.com', 'api.github.com'].includes(new URL(value).hostname)))
      configurationError(
        'GitHub authority must use the dedicated broker',
        'SOURCE_CREDENTIAL_FORBIDDEN',
        403,
      );
    await assertServiceCredential(value, purposes, origins);
  }
  return {
    get(id: string): ConfigurationCredential {
      return project(row(id));
    },
    list(): ConfigurationCredential[] {
      return (
        db.prepare('SELECT * FROM configuration_credentials ORDER BY name').all() as Row[]
      ).map(project);
    },
    async create(raw: unknown): Promise<ConfigurationCredential> {
      const input = inputSchema.parse(raw);
      await verify(input.value, input.purposes, input.origins);
      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO configuration_credentials(id,name,purposes,origins,encrypted_value,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        input.name,
        JSON.stringify(input.purposes),
        JSON.stringify(input.origins),
        cipher.encrypt(input.value),
        now,
        now,
      );
      return project(row(id));
    },
    async rotate(
      id: string,
      expectedRevision: number,
      value: string,
    ): Promise<ConfigurationCredential> {
      z.string().min(1).max(100_000).parse(value);
      const previous = project(row(id));
      if (previous.revoked)
        configurationError(
          'Revoked credentials cannot be reactivated under the same identity',
          'CONFIG_CREDENTIAL_REVOKED',
          403,
        );
      await verify(value, previous.purposes, previous.origins);
      const changed = db
        .prepare(
          'UPDATE configuration_credentials SET encrypted_value=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND revoked=0',
        )
        .run(cipher.encrypt(value), new Date().toISOString(), id, expectedRevision).changes;
      if (changed !== 1)
        configurationError('Credential changed before rotation', 'CONFIG_CREDENTIAL_CHANGED', 409);
      return project(row(id));
    },
    revoke(id: string, expectedRevision: number): ConfigurationCredential {
      const changed = db
        .prepare(
          "UPDATE configuration_credentials SET revoked=1,encrypted_value='',revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(new Date().toISOString(), id, expectedRevision).changes;
      if (changed !== 1)
        configurationError(
          'Credential changed before revocation',
          'CONFIG_CREDENTIAL_CHANGED',
          409,
        );
      return project(row(id));
    },
    async resolve(
      id: string,
      expectedCreatedAt: string,
      use: ConfigurationCredentialPurpose,
      destination?: string,
    ): Promise<string> {
      const stored = row(id);
      const metadata = project(stored);
      if (metadata.revoked || metadata.createdAt !== expectedCreatedAt)
        configurationError('Credential was revoked or replaced', 'CONFIG_CREDENTIAL_REVOKED', 403);
      if (
        !metadata.purposes.includes(use) ||
        (destination && !metadata.origins.includes(new URL(destination).origin))
      )
        configurationError(
          'Credential is not allowed for this service or purpose',
          'CONFIG_CREDENTIAL_SCOPE',
          403,
        );
      const value = cipher.decrypt(stored.encrypted_value);
      await verify(value, metadata.purposes, metadata.origins);
      const current = row(id);
      if (current.revoked || current.revision !== stored.revision)
        configurationError(
          'Credential changed during resolution',
          'CONFIG_CREDENTIAL_CHANGED',
          409,
        );
      return value;
    },
  };
}
export type ConfigurationCredentialStore = ReturnType<typeof createConfigurationCredentialStore>;
