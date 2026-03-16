import { z } from 'zod';

export const configSchema = z.object({
  daemon: z.string().url().optional(),
  defaultModel: z.string().optional(),
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
});

export type CliConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: CliConfig = {
  daemon: 'http://localhost:3100',
};
