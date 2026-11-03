import { z } from 'zod';

const executableName = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const repository = z
  .string()
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
const relativeFile = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value
        .split('/')
        .every(
          (part) => /^[a-zA-Z0-9_.][a-zA-Z0-9_.+-]*$/.test(part) && !['.', '..'].includes(part),
        ),
    'Use a relative file path without traversal or shell syntax',
  );
const archiveMember = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => relativeFile.safeParse(value.startsWith('./') ? value.slice(2) : value).success,
    'Use an exact archive member path without traversal (a leading ./ is allowed)',
  );
const releaseAsset = z
  .object({
    platform: z.enum(['linux/amd64', 'linux/arm64']),
    asset: z
      .string()
      .max(256)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    format: z.enum(['binary', 'tar.gz']),
    executable: archiveMember.optional(),
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (asset.format === 'tar.gz' && !asset.executable)
      ctx.addIssue({
        code: 'custom',
        path: ['executable'],
        message: 'Select the executable inside the archive',
      });
    if (asset.format === 'binary' && asset.executable)
      ctx.addIssue({
        code: 'custom',
        path: ['executable'],
        message: 'A raw binary has no archive member',
      });
  });

/** Operator-authored software recipes. No credentials, mutable Git refs or arbitrary download URLs. */
export const cliToolSchema = z
  .object({
    name: executableName,
    description: z.string().trim().min(1).max(500),
    instructions: z.string().trim().min(1).max(10_000),
    usage: z.enum(['instructed', 'discretionary']).default('instructed'),
    requiredCapabilities: z.array(z.string().min(1).max(128)).max(32).default([]),
    // Must be an offline, non-mutating probe, requiring no provider login.
    verifyArgs: z.array(z.string().max(1024)).min(1).max(32),
    source: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('npm'),
          package: z
            .string()
            .max(214)
            .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/),
          version: exactVersion,
          executable: executableName,
        })
        .strict(),
      z
        .object({
          type: z.literal('github-source'),
          repository,
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          buildCommands: z.array(z.string().trim().min(1).max(10_000)).min(1).max(32),
          executable: relativeFile,
        })
        .strict(),
      z
        .object({
          type: z.literal('github-release'),
          repository,
          tag: z
            .string()
            .max(128)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/),
          assets: z
            .array(releaseAsset)
            .min(1)
            .max(2)
            .refine(
              (assets) => new Set(assets.map((asset) => asset.platform)).size === assets.length,
              'Duplicate release platforms',
            ),
        })
        .strict(),
    ]),
  })
  .strict();

export type CliTool = z.infer<typeof cliToolSchema>;
