import { z } from 'zod';

export const daemonConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3100),
  host: z.string().default('0.0.0.0'),
  dbPath: z.string().default('./autopod.db'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Auth
  entraClientId: z.string().min(1),
  entraTenantId: z.string().min(1),

  // Key Vault
  keyVaultUrl: z.string().url().optional(),

  // Docker
  dockerSocket: z.string().default('/var/run/docker.sock'),

  // Notifications
  teamsWebhookUrl: z.string().url().optional(),
});

export type DaemonConfig = z.infer<typeof daemonConfigSchema>;
