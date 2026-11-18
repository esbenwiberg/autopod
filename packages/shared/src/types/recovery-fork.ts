import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const file = z.object({ path: z.string().min(1).max(1024), version: hash }).strict();
export const recoveryForkInputSchema = z
  .object({
    version: z.literal(1),
    expectedGeneration: z.number().int().min(1),
    sourceHead: sha,
    executionProfileId: z.string().min(1).max(128),
    instructions: z.string().trim().max(8000).default(''),
    files: z
      .array(file)
      .max(100)
      .refine((v) => new Set(v.map((f) => f.path)).size === v.length),
    acknowledgePartialSource: z.literal(true),
  })
  .strict();
export const recoveryForkRequestSchema = recoveryForkInputSchema
  .extend({
    id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    expectedBinding: hash,
  })
  .strict();
export type RecoveryForkInput = z.infer<typeof recoveryForkInputSchema>;
export type RecoveryForkRequest = z.infer<typeof recoveryForkRequestSchema>;
export const recoveryHandoffPreparationSchema = z
  .object({
    expectedGeneration: z.number().int().min(1),
    instructions: z.string().trim().max(8000).default(''),
  })
  .strict();
export interface RecoveryHandoffPreparation {
  version: 1;
  podId: string;
  generation: number;
  actorId: string;
  createdAt: string;
  coverage: 'brief-only' | 'inherited-checkpoint' | 'saved-checkpoint';
  source: { podId: string; head: string; tree: string; bundleHash: string; savedAt: string } | null;
  packet: string;
  packetHash: string;
  workerStarted: false;
}
export interface RecoveryHandoffPreparationState {
  version: 1;
  podId: string;
  generation: number;
  available: boolean;
  blockers: string[];
  context: RecoveryForkContext;
  receipt: RecoveryHandoffPreparation | null;
  operation?: RecoveryForkOperation | null;
}
export interface RecoveryForkFile {
  path: string;
  size: number;
  version: string;
}
export interface RecoveryForkSource {
  head: string;
  tree: string;
  baseCommitSha: string;
  branch: string;
  repository: string;
  files: RecoveryForkFile[];
  truncated: boolean;
  skippedEntries: number;
  caveats: string[];
  savedCheckpointHash?: string;
}
export interface RecoveryForkContext {
  summary: string;
  failure: string;
  messages: Array<{
    role: 'human' | 'assistant';
    text: string;
    timestamp: string;
    eventId: number;
  }>;
  truncated: boolean;
  omissions: string[];
  decisions?: string;
  reports?: Array<{
    source: string;
    timestamp: string;
    sha256: string;
    text: string;
    omissions: string;
  }>;
  attempts?: Array<{
    podId: string;
    capturedAt: string;
    sourceHead: string;
    packetHash: string;
    summary: string;
    failure: string;
    messages: RecoveryForkContext['messages'];
    omissions: string[];
    operatorNote?: string;
    decisions?: string;
    reports?: RecoveryForkContext['reports'];
  }>;
}
export interface RecoveryForkBudget {
  taskId: string;
  status: 'unlimited' | 'below_recorded_limit' | 'exhausted' | 'unavailable';
  tokenBudget: number | null;
  recordedTokens: number | null;
  retryAuthorizationRequired: boolean | null;
}
export interface RecoveryForkExecution {
  profileId: string;
  target: string;
  template: string;
  platform: string;
  memoryGb: number;
  cpus: number | null;
  originalTemplate: string;
  sameEnvironment: boolean;
}
export interface RecoveryForkInspection {
  version: 1;
  podId: string;
  generation: number;
  available: boolean;
  blockers: string[];
  source: RecoveryForkSource | null;
  context: RecoveryForkContext;
  budget: RecoveryForkBudget | null;
  profiles: Array<{ id: string; label: string }>;
  operation: RecoveryForkOperation | null;
  lineage: { parentPodId: string; operationId: string } | null;
}
export interface RecoveryForkPreview {
  version: 1;
  podId: string;
  generation: number;
  available: boolean;
  blockers: string[];
  expectedBinding: string | null;
  source: RecoveryForkSource | null;
  context: RecoveryForkContext;
  budget: RecoveryForkBudget | null;
  execution: RecoveryForkExecution | null;
  input: RecoveryForkInput;
}
export interface RecoveryForkOperation {
  version: 1;
  id: string;
  parentPodId: string;
  generation: number;
  actorId: string;
  request: RecoveryForkRequest;
  state: 'preparing' | 'queued' | 'qualifying' | 'qualified' | 'failed' | 'unknown';
  childPodId: string | null;
  childStatus: string | null;
  sourceHead: string;
  copiedFiles: string[];
  context: RecoveryForkContext;
  error: string | null;
  createdAt: string;
  workerBrief?: string;
}
