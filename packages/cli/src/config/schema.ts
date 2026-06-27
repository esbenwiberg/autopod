import { z } from 'zod';

export const configSchema = z.object({
  daemon: z.string().url().optional(),
  defaultModel: z.string().optional(),
  auth: z
    .object({
      clientId: z.string().min(1).optional(),
      tenantId: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  notifications: z
    .object({
      teams: z.boolean().optional(),
      desktop: z.boolean().optional(),
    })
    .optional(),
  watch: z
    .object({
      theme: z.enum(['dark', 'light']).optional(),
      refreshInterval: z.number().int().min(500).max(10000).optional(),
    })
    .optional(),
  mobile: z
    .object({
      // Tailnet hostname the laptop is reachable as, e.g. mymac.tail1234.ts.net.
      // Cached from `tailscale status --json` on first `ap mobile pair`.
      host: z.string().min(1).optional(),
    })
    .optional(),
});

export type CliConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: CliConfig = {
  daemon: 'http://localhost:3100',
};
