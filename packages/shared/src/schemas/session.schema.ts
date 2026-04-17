// Re-export shim — all schemas have moved to pod.schema.ts.
// This file exists only to ease the rename transition and will be removed.
export {
  createPodRequestSchema as createSessionRequestSchema,
  podStatusSchema as sessionStatusSchema,
  sendMessageSchema,
} from './pod.schema.js';
