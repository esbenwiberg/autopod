---
title: "Phase 1: Foundation"
status: exploring
published: true
date: 2026-03-15
---

> The ground floor. Nothing else starts until this is solid. Monorepo, shared types, database schema, dev environment — the foundation every other phase builds on.

## Milestone M0: Monorepo Scaffold + Shared Types + Dev Environment

This is a single, sequential milestone. No parallelism within it — each task depends on the one before it. The output is a fully buildable, lintable, testable monorepo with all types defined, a working daemon health endpoint, a CLI that prints its version, and a SQLite migration system that creates all tables.

---

## Final Directory Structure

```
autopod/
├── packages/
│   ├── cli/
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── daemon/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── server.ts
│   │   │   └── db/
│   │   │       ├── connection.ts
│   │   │       ├── migrate.ts
│   │   │       └── migrations/
│   │   │           └── 001_initial.sql
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── shared/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types/
│   │   │   │   ├── session.ts
│   │   │   │   ├── profile.ts
│   │   │   │   ├── runtime.ts
│   │   │   │   ├── validation.ts
│   │   │   │   ├── escalation.ts
│   │   │   │   ├── events.ts
│   │   │   │   ├── notification.ts
│   │   │   │   └── auth.ts
│   │   │   ├── schemas/
│   │   │   │   ├── session.schema.ts
│   │   │   │   ├── profile.schema.ts
│   │   │   │   └── config.schema.ts
│   │   │   ├── constants.ts
│   │   │   └── errors.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── validator/
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── escalation-mcp/
│       ├── src/
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── templates/
│   └── base/
│       ├── Dockerfile.node22
│       └── Dockerfile.node22-pw
├── infra/
│   └── .gitkeep
├── e2e/
│   └── .gitkeep
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── biome.json
├── vitest.workspace.ts
├── docker-compose.yml
├── .env.example
├── .gitignore
└── .github/
    └── workflows/
        └── ci.yml
```

---

## Task 1: Initialize Monorepo Root

Create the workspace root with pnpm, Turborepo, shared TypeScript config, and Biome.

### `package.json` (workspace root)

```json
{
  "name": "autopod",
  "private": true,
  "packageManager": "pnpm@9.15.4",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "dev": "turbo run dev",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "turbo": "^2.3.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.4"
  }
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
  - "e2e"
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "clean": {
      "cache": false
    }
  }
}
```

### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false
  },
  "exclude": ["node_modules", "dist"]
}
```

Key decisions in the tsconfig:
- `moduleResolution: "bundler"` — we're using tsup (esbuild), not raw tsc output. This allows bare specifier imports and `.js` extension-free imports.
- `verbatimModuleSyntax: true` — forces explicit `import type` for type-only imports. Prevents accidental runtime imports of types.
- `noUncheckedIndexedAccess: true` — array/record access returns `T | undefined`. Catches real bugs.
- `isolatedModules: true` — required for esbuild compatibility.

### `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noForEach": "off"
      },
      "style": {
        "noNonNullAssertion": "warn",
        "useConst": "error"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  },
  "files": {
    "ignore": ["**/dist/**", "**/node_modules/**", "**/.turbo/**"]
  }
}
```

### `vitest.workspace.ts`

```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*/vitest.config.ts',
]);
```

### `.gitignore`

```
node_modules/
dist/
.turbo/
*.db
*.db-journal
.env
.env.local
coverage/
```

### Steps

```bash
# 1. Initialize
pnpm init

# 2. Install root dev deps
pnpm add -Dw turbo typescript @biomejs/biome vitest

# 3. Create pnpm-workspace.yaml
# 4. Create turbo.json
# 5. Create tsconfig.base.json
# 6. Create biome.json
# 7. Create vitest.workspace.ts
# 8. Create .gitignore
# 9. Create empty dirs: infra/, e2e/, templates/base/

# Verify:
pnpm install  # should succeed (no packages yet, but workspace is valid)
```

---

## Task 2: Create `packages/shared`

The contract layer. All types, schemas, errors, and constants. Every other package imports from `@autopod/shared`. This package has **zero runtime dependencies beyond zod and nanoid**.

### `packages/shared/package.json`

```json
{
  "name": "@autopod/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "clean": "rm -rf dist",
    "test": "vitest run",
    "dev": "tsup --watch"
  },
  "dependencies": {
    "nanoid": "^5.0.9",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.7.3",
    "vitest": "^3.0.4"
  }
}
```

### `packages/shared/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### `packages/shared/tsup.config.ts`

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

### `packages/shared/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

### Source Files

Every type from the [Data Model](./data-model) must be implemented. Here is the exact content for each file.

#### `src/types/session.ts`

```typescript
import type { EscalationRequest } from './escalation.js';
import type { RuntimeType } from './runtime.js';
import type { ValidationResult } from './validation.js';

export type SessionStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'awaiting_input'
  | 'validating'
  | 'validated'
  | 'failed'
  | 'approved'
  | 'merging'
  | 'complete'
  | 'killing'
  | 'killed';

export interface Session {
  id: string;
  profileName: string;
  task: string;
  status: SessionStatus;
  model: string;
  runtime: RuntimeType;
  branch: string;
  containerId: string | null;
  worktreePath: string | null;
  validationAttempts: number;
  maxValidationAttempts: number;
  lastValidationResult: ValidationResult | null;
  pendingEscalation: EscalationRequest | null;
  escalationCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  userId: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  previewUrl: string | null;
}

export interface CreateSessionRequest {
  profileName: string;
  task: string;
  model?: string;
  runtime?: RuntimeType;
  branch?: string;
  skipValidation?: boolean;
}

export interface SessionSummary {
  id: string;
  profileName: string;
  task: string;
  status: SessionStatus;
  model: string;
  runtime: RuntimeType;
  duration: number | null;
  filesChanged: number;
  createdAt: string;
}
```

#### `src/types/profile.ts`

```typescript
import type { RuntimeType } from './runtime.js';

export type StackTemplate =
  | 'node22'
  | 'node22-pw'
  | 'dotnet9'
  | 'python312'
  | 'custom';

export interface Profile {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  template: StackTemplate;
  buildCommand: string;
  startCommand: string;
  healthPath: string;
  healthTimeout: number;
  validationPages: ValidationPage[];
  maxValidationAttempts: number;
  defaultModel: string;
  defaultRuntime: RuntimeType;
  customInstructions: string | null;
  escalation: EscalationConfig;
  extends: string | null;
  warmImageTag: string | null;
  warmImageBuiltAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationPage {
  path: string;
  assertions?: PageAssertion[];
}

export interface PageAssertion {
  selector: string;
  type: 'exists' | 'text_contains' | 'visible' | 'count';
  value?: string;
}

export interface EscalationConfig {
  askHuman: boolean;
  askAi: {
    enabled: boolean;
    model: string;
    maxCalls: number;
  };
  autoPauseAfter: number;
  humanResponseTimeout: number;
}
```

#### `src/types/runtime.ts`

```typescript
export type RuntimeType = 'claude' | 'codex';

export interface Runtime {
  type: RuntimeType;
  spawn(config: SpawnConfig): AsyncIterable<AgentEvent>;
  resume(sessionId: string, message: string): AsyncIterable<AgentEvent>;
  abort(sessionId: string): Promise<void>;
}

export interface SpawnConfig {
  sessionId: string;
  task: string;
  model: string;
  workDir: string;
  customInstructions?: string;
  env: Record<string, string>;
  mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
  name: string;
  url: string;
}

export type AgentEvent =
  | AgentStatusEvent
  | AgentToolUseEvent
  | AgentFileChangeEvent
  | AgentCompleteEvent
  | AgentErrorEvent
  | AgentEscalationEvent;

export interface AgentStatusEvent {
  type: 'status';
  timestamp: string;
  message: string;
}

export interface AgentToolUseEvent {
  type: 'tool_use';
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  output?: string;
}

export interface AgentFileChangeEvent {
  type: 'file_change';
  timestamp: string;
  path: string;
  action: 'create' | 'modify' | 'delete';
  diff?: string;
}

export interface AgentCompleteEvent {
  type: 'complete';
  timestamp: string;
  result: string;
}

export interface AgentErrorEvent {
  type: 'error';
  timestamp: string;
  message: string;
  fatal: boolean;
}

export interface AgentEscalationEvent {
  type: 'escalation';
  timestamp: string;
  escalationType: 'ask_human' | 'ask_ai' | 'report_blocker';
  payload: import('./escalation.js').EscalationRequest;
}
```

#### `src/types/validation.ts`

```typescript
import type { PageAssertion } from './profile.js';

export interface ValidationResult {
  sessionId: string;
  attempt: number;
  timestamp: string;
  smoke: SmokeResult;
  taskReview: TaskReviewResult | null;
  overall: 'pass' | 'fail';
  duration: number;
}

export interface SmokeResult {
  status: 'pass' | 'fail';
  build: BuildResult;
  health: HealthResult;
  pages: PageResult[];
}

export interface BuildResult {
  status: 'pass' | 'fail';
  output: string;
  duration: number;
}

export interface HealthResult {
  status: 'pass' | 'fail';
  url: string;
  responseCode: number | null;
  duration: number;
}

export interface PageResult {
  path: string;
  status: 'pass' | 'fail';
  screenshotPath: string;
  consoleErrors: string[];
  assertions: AssertionResult[];
  loadTime: number;
}

export interface AssertionResult {
  selector: string;
  type: PageAssertion['type'];
  expected: string | undefined;
  actual: string | undefined;
  passed: boolean;
}

export interface TaskReviewResult {
  status: 'pass' | 'fail' | 'uncertain';
  reasoning: string;
  issues: string[];
  model: string;
  screenshots: string[];
  diff: string;
}
```

#### `src/types/escalation.ts`

```typescript
export type EscalationType = 'ask_human' | 'ask_ai' | 'report_blocker';

export interface EscalationRequest {
  id: string;
  sessionId: string;
  type: EscalationType;
  timestamp: string;
  payload: AskHumanPayload | AskAiPayload | ReportBlockerPayload;
  response: EscalationResponse | null;
}

export interface AskHumanPayload {
  question: string;
  context?: string;
  options?: string[];
}

export interface AskAiPayload {
  question: string;
  context?: string;
  domain?: string;
}

export interface ReportBlockerPayload {
  description: string;
  attempted: string[];
  needs: string;
}

export interface EscalationResponse {
  respondedAt: string;
  respondedBy: 'human' | 'ai';
  response: string;
  model?: string;
}
```

#### `src/types/events.ts`

```typescript
import type { EscalationRequest, EscalationResponse } from './escalation.js';
import type { AgentEvent } from './runtime.js';
import type { SessionStatus, SessionSummary } from './session.js';
import type { ValidationResult } from './validation.js';

export type SystemEvent =
  | SessionCreatedEvent
  | SessionStatusChangedEvent
  | AgentActivityEvent
  | ValidationStartedEvent
  | ValidationCompletedEvent
  | EscalationCreatedEvent
  | EscalationResolvedEvent
  | SessionCompletedEvent;

export interface SessionCreatedEvent {
  type: 'session.created';
  timestamp: string;
  session: SessionSummary;
}

export interface SessionStatusChangedEvent {
  type: 'session.status_changed';
  timestamp: string;
  sessionId: string;
  previousStatus: SessionStatus;
  newStatus: SessionStatus;
}

export interface AgentActivityEvent {
  type: 'session.agent_activity';
  timestamp: string;
  sessionId: string;
  event: AgentEvent;
}

export interface ValidationStartedEvent {
  type: 'session.validation_started';
  timestamp: string;
  sessionId: string;
  attempt: number;
}

export interface ValidationCompletedEvent {
  type: 'session.validation_completed';
  timestamp: string;
  sessionId: string;
  result: ValidationResult;
}

export interface EscalationCreatedEvent {
  type: 'session.escalation_created';
  timestamp: string;
  sessionId: string;
  escalation: EscalationRequest;
}

export interface EscalationResolvedEvent {
  type: 'session.escalation_resolved';
  timestamp: string;
  sessionId: string;
  escalationId: string;
  response: EscalationResponse;
}

export interface SessionCompletedEvent {
  type: 'session.completed';
  timestamp: string;
  sessionId: string;
  finalStatus: 'complete' | 'killed';
  summary: SessionSummary;
}
```

#### `src/types/notification.ts`

```typescript
import type { EscalationRequest } from './escalation.js';
import type { ValidationResult } from './validation.js';

export type NotificationType =
  | 'session_validated'
  | 'session_failed'
  | 'session_needs_input'
  | 'session_error';

export interface NotificationPayload {
  type: NotificationType;
  sessionId: string;
  profileName: string;
  task: string;
  timestamp: string;
}

export interface SessionValidatedNotification extends NotificationPayload {
  type: 'session_validated';
  previewUrl: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  duration: number;
}

export interface SessionFailedNotification extends NotificationPayload {
  type: 'session_failed';
  reason: string;
  validationResult: ValidationResult | null;
  screenshotUrl: string | null;
}

export interface SessionNeedsInputNotification extends NotificationPayload {
  type: 'session_needs_input';
  escalation: EscalationRequest;
}

export interface SessionErrorNotification extends NotificationPayload {
  type: 'session_error';
  error: string;
  fatal: boolean;
}
```

#### `src/types/auth.ts`

```typescript
export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  displayName: string;
  email: string;
  roles: AppRole[];
}

export type AppRole = 'admin' | 'operator' | 'viewer';

export interface JwtPayload {
  oid: string;
  preferred_username: string;
  name: string;
  roles: AppRole[];
  aud: string;
  iss: string;
  exp: number;
  iat: number;
}

export interface DaemonConnection {
  url: string;
  healthy: boolean;
  version: string;
  lastChecked: string;
}
```

#### `src/constants.ts`

```typescript
import type { SessionStatus } from './types/session.js';

export const SESSION_ID_LENGTH = 8;
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;
export const DEFAULT_HEALTH_TIMEOUT = 120;
export const DEFAULT_HUMAN_RESPONSE_TIMEOUT = 3600;
export const DEFAULT_MAX_AI_ESCALATIONS = 5;
export const DEFAULT_AUTO_PAUSE_AFTER = 3;
export const MAX_BUILD_LOG_LENGTH = 10_000;
export const MAX_DIFF_LENGTH = 50_000;
export const SCREENSHOT_QUALITY = 80;
export const EVENT_LOG_RETENTION_DAYS = 30;

export const VALID_STATUS_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  queued: ['provisioning', 'killing'],
  provisioning: ['running', 'killing'],
  running: ['awaiting_input', 'validating', 'killing'],
  awaiting_input: ['running', 'killing'],
  validating: ['validated', 'running', 'failed'],
  validated: ['approved', 'running'],
  failed: ['running', 'killing'],
  approved: ['merging'],
  merging: ['complete'],
  complete: [],
  killing: ['killed'],
  killed: [],
};
```

#### `src/errors.ts`

```typescript
import type { RuntimeType } from './types/runtime.js';
import type { SessionStatus } from './types/session.js';

export class AutopodError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AutopodError';
  }
}

export class AuthError extends AutopodError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AutopodError {
  constructor(message: string) {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

export class SessionNotFoundError extends AutopodError {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND', 404);
    this.name = 'SessionNotFoundError';
  }
}

export class InvalidStateTransitionError extends AutopodError {
  constructor(sessionId: string, from: SessionStatus, to: SessionStatus) {
    super(
      `Cannot transition session ${sessionId} from ${from} to ${to}`,
      'INVALID_STATE_TRANSITION',
      409,
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class ProfileNotFoundError extends AutopodError {
  constructor(name: string) {
    super(`Profile "${name}" not found`, 'PROFILE_NOT_FOUND', 404);
    this.name = 'ProfileNotFoundError';
  }
}

export class ProfileExistsError extends AutopodError {
  constructor(name: string) {
    super(`Profile "${name}" already exists`, 'PROFILE_EXISTS', 409);
    this.name = 'ProfileExistsError';
  }
}

export class ContainerError extends AutopodError {
  constructor(message: string) {
    super(message, 'CONTAINER_ERROR', 500);
    this.name = 'ContainerError';
  }
}

export class ValidationError extends AutopodError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 500);
    this.name = 'ValidationError';
  }
}

export class RuntimeError extends AutopodError {
  constructor(message: string, public readonly runtime: RuntimeType) {
    super(message, 'RUNTIME_ERROR', 500);
    this.name = 'RuntimeError';
  }
}
```

#### `src/schemas/session.schema.ts`

```typescript
import { z } from 'zod';

export const createSessionRequestSchema = z.object({
  profileName: z.string().min(1).max(64),
  task: z.string().min(1).max(10_000),
  model: z.string().min(1).max(32).optional(),
  runtime: z.enum(['claude', 'codex']).optional(),
  branch: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9\-_/]+$/, 'Branch name contains invalid characters')
    .optional(),
  skipValidation: z.boolean().optional(),
});

export const sessionStatusSchema = z.enum([
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'validating',
  'validated',
  'failed',
  'approved',
  'merging',
  'complete',
  'killing',
  'killed',
]);

export const sendMessageSchema = z.object({
  message: z.string().min(1).max(50_000),
});
```

#### `src/schemas/profile.schema.ts`

```typescript
import { z } from 'zod';

const pageAssertionSchema = z.object({
  selector: z.string().min(1),
  type: z.enum(['exists', 'text_contains', 'visible', 'count']),
  value: z.string().optional(),
});

const validationPageSchema = z.object({
  path: z.string().min(1).startsWith('/'),
  assertions: z.array(pageAssertionSchema).optional(),
});

const escalationConfigSchema = z.object({
  askHuman: z.boolean().default(true),
  askAi: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default('sonnet'),
      maxCalls: z.number().int().min(0).max(50).default(5),
    })
    .default({}),
  autoPauseAfter: z.number().int().min(1).max(20).default(3),
  humanResponseTimeout: z.number().int().min(60).max(86_400).default(3600),
});

export const createProfileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9\-]+$/, 'Profile name must be lowercase alphanumeric with hyphens'),
  repoUrl: z.string().url(),
  defaultBranch: z.string().default('main'),
  template: z.enum(['node22', 'node22-pw', 'dotnet9', 'python312', 'custom']).default('node22'),
  buildCommand: z.string().min(1),
  startCommand: z.string().min(1),
  healthPath: z.string().default('/'),
  healthTimeout: z.number().int().min(10).max(600).default(120),
  validationPages: z.array(validationPageSchema).default([]),
  maxValidationAttempts: z.number().int().min(1).max(10).default(3),
  defaultModel: z.string().default('opus'),
  defaultRuntime: z.enum(['claude', 'codex']).default('claude'),
  customInstructions: z.string().max(50_000).nullable().default(null),
  escalation: escalationConfigSchema.default({}),
  extends: z.string().nullable().default(null),
});

export const updateProfileSchema = createProfileSchema.partial().omit({ name: true });
```

#### `src/schemas/config.schema.ts`

```typescript
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
```

#### `src/index.ts` (barrel export)

```typescript
// Types
export type {
  SessionStatus,
  Session,
  CreateSessionRequest,
  SessionSummary,
} from './types/session.js';

export type {
  Profile,
  StackTemplate,
  ValidationPage,
  PageAssertion,
  EscalationConfig,
} from './types/profile.js';

export type {
  RuntimeType,
  Runtime,
  SpawnConfig,
  McpServerConfig,
  AgentEvent,
  AgentStatusEvent,
  AgentToolUseEvent,
  AgentFileChangeEvent,
  AgentCompleteEvent,
  AgentErrorEvent,
  AgentEscalationEvent,
} from './types/runtime.js';

export type {
  ValidationResult,
  SmokeResult,
  BuildResult,
  HealthResult,
  PageResult,
  AssertionResult,
  TaskReviewResult,
} from './types/validation.js';

export type {
  EscalationType,
  EscalationRequest,
  AskHumanPayload,
  AskAiPayload,
  ReportBlockerPayload,
  EscalationResponse,
} from './types/escalation.js';

export type {
  SystemEvent,
  SessionCreatedEvent,
  SessionStatusChangedEvent,
  AgentActivityEvent,
  ValidationStartedEvent,
  ValidationCompletedEvent,
  EscalationCreatedEvent,
  EscalationResolvedEvent,
  SessionCompletedEvent,
} from './types/events.js';

export type {
  NotificationType,
  NotificationPayload,
  SessionValidatedNotification,
  SessionFailedNotification,
  SessionNeedsInputNotification,
  SessionErrorNotification,
} from './types/notification.js';

export type {
  AuthToken,
  AppRole,
  JwtPayload,
  DaemonConnection,
} from './types/auth.js';

// Errors (runtime values, not just types)
export {
  AutopodError,
  AuthError,
  ForbiddenError,
  SessionNotFoundError,
  InvalidStateTransitionError,
  ProfileNotFoundError,
  ProfileExistsError,
  ContainerError,
  ValidationError,
  RuntimeError,
} from './errors.js';

// Constants (runtime values)
export {
  SESSION_ID_LENGTH,
  DEFAULT_MAX_VALIDATION_ATTEMPTS,
  DEFAULT_HEALTH_TIMEOUT,
  DEFAULT_HUMAN_RESPONSE_TIMEOUT,
  DEFAULT_MAX_AI_ESCALATIONS,
  DEFAULT_AUTO_PAUSE_AFTER,
  MAX_BUILD_LOG_LENGTH,
  MAX_DIFF_LENGTH,
  SCREENSHOT_QUALITY,
  EVENT_LOG_RETENTION_DAYS,
  VALID_STATUS_TRANSITIONS,
} from './constants.js';

// Schemas (runtime values — Zod objects)
export {
  createSessionRequestSchema,
  sessionStatusSchema,
  sendMessageSchema,
} from './schemas/session.schema.js';

export {
  createProfileSchema,
  updateProfileSchema,
} from './schemas/profile.schema.js';

export {
  daemonConfigSchema,
  type DaemonConfig,
} from './schemas/config.schema.js';

// ID generation utility
export { generateId } from './id.js';
```

#### `src/id.ts`

A thin wrapper around nanoid, using the configured length:

```typescript
import { nanoid } from 'nanoid';
import { SESSION_ID_LENGTH } from './constants.js';

export function generateId(length: number = SESSION_ID_LENGTH): string {
  return nanoid(length);
}
```

### Verification

```bash
cd packages/shared
pnpm build   # should produce dist/ with index.js + index.d.ts
```

---

## Task 3: Create `packages/daemon` Scaffold

Fastify server with a health endpoint and SQLite migration system. No business logic — just proof of life.

### `packages/daemon/package.json`

```json
{
  "name": "@autopod/daemon",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "clean": "rm -rf dist",
    "test": "vitest run",
    "dev": "tsup --watch --onSuccess 'node dist/index.js'",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@autopod/shared": "workspace:*",
    "better-sqlite3": "^11.7.0",
    "fastify": "^5.2.1",
    "pino": "^9.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "tsup": "^8.3.5",
    "typescript": "^5.7.3",
    "vitest": "^3.0.4"
  }
}
```

### `packages/daemon/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### `packages/daemon/tsup.config.ts`

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['better-sqlite3'],
});
```

### `packages/daemon/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

### `src/db/migrations/001_initial.sql`

This is the full initial migration. Copy exactly from the [Data Model](./data-model) SQL schema:

```sql
-- Profiles
CREATE TABLE IF NOT EXISTS profiles (
  name            TEXT PRIMARY KEY,
  repo_url        TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  template        TEXT NOT NULL DEFAULT 'node22',
  build_command   TEXT NOT NULL,
  start_command   TEXT NOT NULL,
  health_path     TEXT NOT NULL DEFAULT '/',
  health_timeout  INTEGER NOT NULL DEFAULT 120,
  validation_pages TEXT NOT NULL DEFAULT '[]',
  max_validation_attempts INTEGER NOT NULL DEFAULT 3,
  default_model   TEXT NOT NULL DEFAULT 'opus',
  default_runtime TEXT NOT NULL DEFAULT 'claude',
  custom_instructions TEXT,
  escalation_config TEXT NOT NULL DEFAULT '{}',
  extends         TEXT REFERENCES profiles(name),
  warm_image_tag  TEXT,
  warm_image_built_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  profile_name    TEXT NOT NULL REFERENCES profiles(name),
  task            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  model           TEXT NOT NULL,
  runtime         TEXT NOT NULL DEFAULT 'claude',
  branch          TEXT NOT NULL,
  container_id    TEXT,
  worktree_path   TEXT,
  validation_attempts INTEGER NOT NULL DEFAULT 0,
  max_validation_attempts INTEGER NOT NULL DEFAULT 3,
  last_validation_result TEXT,
  pending_escalation TEXT,
  escalation_count INTEGER NOT NULL DEFAULT 0,
  skip_validation BOOLEAN NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  completed_at    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  user_id         TEXT NOT NULL,
  files_changed   INTEGER NOT NULL DEFAULT 0,
  lines_added     INTEGER NOT NULL DEFAULT 0,
  lines_removed   INTEGER NOT NULL DEFAULT 0,
  preview_url     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_name);

-- Escalation history
CREATE TABLE IF NOT EXISTS escalations (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  response        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_id);

-- Validation history
CREATE TABLE IF NOT EXISTS validations (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL,
  result          TEXT NOT NULL,
  screenshots     TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_validations_session ON validations(session_id);

-- Event log (append-only)
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

-- Schema version
CREATE TABLE IF NOT EXISTS schema_version (
  version         INTEGER PRIMARY KEY,
  applied_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `src/db/connection.ts`

```typescript
import Database from 'better-sqlite3';
import type { Logger } from 'pino';

export function createDatabase(dbPath: string, logger: Logger): Database.Database {
  const db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  logger.info({ dbPath }, 'Database connection established');
  return db;
}
```

### `src/db/migrate.ts`

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export function runMigrations(db: Database.Database, migrationsDir: string, logger: Logger): void {
  // Ensure schema_version table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Get current version
  const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
    | { version: number | null }
    | undefined;
  const currentVersion = row?.version ?? 0;

  // Find migration files
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let applied = 0;

  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) {
      logger.warn({ file }, 'Skipping migration file with invalid name');
      continue;
    }

    const version = parseInt(match[1], 10);
    if (version <= currentVersion) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    const migrate = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });

    migrate();
    applied++;
    logger.info({ version, file }, 'Applied migration');
  }

  if (applied === 0) {
    logger.info({ currentVersion }, 'Database schema is up to date');
  } else {
    logger.info({ applied, newVersion: currentVersion + applied }, 'Migrations complete');
  }
}
```

### `src/server.ts`

```typescript
import Fastify from 'fastify';
import type { Logger } from 'pino';

export function createServer(logger: Logger) {
  const app = Fastify({ logger });

  app.get('/health', async () => {
    return { status: 'ok', version: '0.0.1' };
  });

  return app;
}
```

### `src/index.ts`

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

const PORT = parseInt(process.env['PORT'] ?? '3100', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const DB_PATH = process.env['DB_PATH'] ?? './autopod.db';

// Database setup
const db = createDatabase(DB_PATH, logger);

// Run migrations
// In dev: migrations are next to the source. In prod (built): they're copied to dist.
// The tsup build doesn't copy .sql files, so we look in src/ first, then dist/.
const migrationsDir = [
  path.join(__dirname, 'db', 'migrations'),
  path.join(__dirname, '..', 'src', 'db', 'migrations'),
].find((dir) => {
  try {
    return require('node:fs').existsSync(dir);
  } catch {
    return false;
  }
}) ?? path.join(__dirname, '..', 'src', 'db', 'migrations');

runMigrations(db, migrationsDir, logger);

// Start server
const app = createServer(logger);

try {
  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, 'Autopod daemon started');
} catch (err) {
  logger.fatal(err, 'Failed to start daemon');
  process.exit(1);
}
```

**Important note on migrations directory**: tsup does not copy non-TS files. The build script in `tsup.config.ts` must be updated to copy SQL migrations, OR the daemon must reference the `src/` directory for migrations. The simplest approach for Phase 1: add a `postbuild` script that copies migrations:

```json
{
  "scripts": {
    "build": "tsup && cp -r src/db/migrations dist/db/",
    "postbuild": "mkdir -p dist/db && cp -r src/db/migrations dist/db/"
  }
}
```

Actually, the cleaner approach — update `tsup.config.ts`:

```typescript
import { defineConfig } from 'tsup';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['better-sqlite3'],
  onSuccess: async () => {
    mkdirSync('dist/db/migrations', { recursive: true });
    cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
  },
});
```

### Verification

```bash
cd packages/daemon
pnpm build    # should produce dist/ with index.js + copied migrations
pnpm start    # should start on port 3100, create autopod.db, apply migration
curl http://localhost:3100/health  # should return {"status":"ok","version":"0.0.1"}
```

---

## Task 4: Create `packages/cli` Scaffold

Basic Commander setup with a `--version` command. Binary name: `ap`.

### `packages/cli/package.json`

```json
{
  "name": "@autopod/cli",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "ap": "./dist/index.js",
    "autopod": "./dist/index.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "clean": "rm -rf dist",
    "test": "vitest run",
    "dev": "tsup --watch"
  },
  "dependencies": {
    "@autopod/shared": "workspace:*",
    "commander": "^13.1.0"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.7.3",
    "vitest": "^3.0.4"
  }
}
```

### `packages/cli/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### `packages/cli/tsup.config.ts`

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
```

### `packages/cli/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

### `packages/cli/src/index.ts`

```typescript
import { Command } from 'commander';

const program = new Command();

program
  .name('ap')
  .description('Autopod — Sandboxed AI coding sessions with self-validation')
  .version('0.0.1');

program.parse(process.argv);
```

### Verification

```bash
cd packages/cli
pnpm build
node dist/index.js --version   # should print "0.0.1"
# After linking: ap --version
```

---

## Task 5: Create `packages/validator` and `packages/escalation-mcp` Scaffolds

Empty packages with minimal exports. These will be filled in during Phase 2 and Phase 3 respectively.

### `packages/validator/package.json`

```json
{
  "name": "@autopod/validator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "clean": "rm -rf dist",
    "test": "vitest run",
    "dev": "tsup --watch"
  },
  "dependencies": {
    "@autopod/shared": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.7.3",
    "vitest": "^3.0.4"
  }
}
```

### `packages/validator/src/index.ts`

```typescript
// Validator — Playwright smoke checks + AI task review
// Implementation coming in Phase 2 (M4)
export const VALIDATOR_VERSION = '0.0.1';
```

### `packages/escalation-mcp/package.json`

```json
{
  "name": "@autopod/escalation-mcp",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "clean": "rm -rf dist",
    "test": "vitest run",
    "dev": "tsup --watch"
  },
  "dependencies": {
    "@autopod/shared": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.7.3",
    "vitest": "^3.0.4"
  }
}
```

### `packages/escalation-mcp/src/index.ts`

```typescript
// Escalation MCP — ask_human, ask_ai, report_blocker tools
// Implementation coming in Phase 3 (M8)
export const ESCALATION_MCP_VERSION = '0.0.1';
```

Both packages also need `tsconfig.json` and `vitest.config.ts` — identical patterns to the other packages:

### `tsconfig.json` (same for both)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### `tsup.config.ts` (same for both)

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

### `vitest.config.ts` (same for both)

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

---

## Task 6: Create Base Dockerfiles

These live in `templates/base/` and are the foundation images for session pods. They don't run anything on their own — they provide the environment.

### `templates/base/Dockerfile.node22`

```dockerfile
FROM node:22-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1000 autopod && \
    useradd --uid 1000 --gid autopod --shell /bin/bash --create-home autopod

# Global tools
RUN npm install -g pnpm@9

# Working directory
WORKDIR /workspace
RUN chown autopod:autopod /workspace

USER autopod

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1
```

### `templates/base/Dockerfile.node22-pw`

```dockerfile
FROM node:22-slim

# System deps + Playwright deps (Chromium)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    # Playwright Chromium dependencies
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1000 autopod && \
    useradd --uid 1000 --gid autopod --shell /bin/bash --create-home autopod

# Global tools
RUN npm install -g pnpm@9

# Pre-install Playwright Chromium (as root, then fix perms)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright install chromium && \
    chmod -R 755 /opt/pw-browsers

# Working directory
WORKDIR /workspace
RUN chown autopod:autopod /workspace

USER autopod

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1
```

---

## Task 7: Create `docker-compose.yml`

For local development. Starts the daemon with a mounted source directory.

### `docker-compose.yml`

```yaml
version: "3.9"

services:
  daemon:
    build:
      context: .
      dockerfile: Dockerfile.daemon.dev
    ports:
      - "3100:3100"
    volumes:
      - ./packages/daemon/src:/app/packages/daemon/src:ro
      - ./packages/shared/src:/app/packages/shared/src:ro
      - daemon-data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - PORT=3100
      - HOST=0.0.0.0
      - DB_PATH=/app/data/autopod.db
      - LOG_LEVEL=debug
      - NODE_ENV=development
      # These are required but not used in Phase 1
      - ENTRA_CLIENT_ID=placeholder
      - ENTRA_TENANT_ID=placeholder
    restart: unless-stopped

volumes:
  daemon-data:
```

### `Dockerfile.daemon.dev`

This is a dev-only Dockerfile at the repo root for docker-compose:

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./

# Copy all package.json files for install
COPY packages/shared/package.json packages/shared/
COPY packages/daemon/package.json packages/daemon/
COPY packages/cli/package.json packages/cli/
COPY packages/validator/package.json packages/validator/
COPY packages/escalation-mcp/package.json packages/escalation-mcp/

RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/daemon/ packages/daemon/
COPY packages/cli/ packages/cli/
COPY packages/validator/ packages/validator/
COPY packages/escalation-mcp/ packages/escalation-mcp/

# Build
RUN pnpm build

EXPOSE 3100

CMD ["node", "packages/daemon/dist/index.js"]
```

---

## Task 8: Create `.env.example` and CI Workflow

### `.env.example`

```bash
# Daemon
PORT=3100
HOST=0.0.0.0
DB_PATH=./autopod.db
LOG_LEVEL=debug
NODE_ENV=development

# Auth (required — get from Entra ID app registration)
ENTRA_CLIENT_ID=
ENTRA_TENANT_ID=

# Azure Key Vault (optional in dev)
# KEY_VAULT_URL=https://my-vault.vault.azure.net

# Docker
DOCKER_SOCKET=/var/run/docker.sock

# Notifications (optional)
# TEAMS_WEBHOOK_URL=https://prod-xx.westeurope.logic.azure.com/workflows/...

# AI API keys (in dev, set directly; in prod, use Key Vault)
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# GitHub (for cloning private repos)
# GITHUB_PAT=
```

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Build
        run: pnpm build

      - name: Test
        run: pnpm test
```

---

## Task 9: Verify Everything Works

Run these commands from the workspace root. Every single one must pass.

```bash
# 1. Install
pnpm install

# 2. Build all packages (turbo pipeline respects dependency order)
pnpm build

# 3. Lint
pnpm lint

# 4. Test (runs even if no test files — exits 0)
pnpm test

# 5. Verify shared types are importable
node -e "import('@autopod/shared').then(m => { console.log(Object.keys(m).length + ' exports'); console.log('generateId:', m.generateId()); })"

# 6. Verify daemon starts and responds to health
cd packages/daemon
node dist/index.js &
DAEMON_PID=$!
sleep 2
curl -s http://localhost:3100/health | grep '"status":"ok"'
kill $DAEMON_PID
cd ../..

# 7. Verify CLI version
node packages/cli/dist/index.js --version  # prints "0.0.1"

# 8. Verify SQLite tables were created
# (After running daemon once, autopod.db should exist with all tables)
sqlite3 packages/daemon/autopod.db ".tables"
# Expected: escalations  events  profiles  schema_version  sessions  validations

# 9. Verify docker-compose (if Docker is available)
docker compose config  # validates compose file

# 10. Verify types compile across packages
# (The build step already proves this — daemon and cli import from shared)
```

---

## Acceptance Criteria Checklist

| # | Criterion | How to Verify |
|---|-----------|---------------|
| 1 | `pnpm install` succeeds from workspace root | Run it. Exit code 0. |
| 2 | `pnpm build` builds all packages via turbo pipeline | Run it. All 5 packages build. No errors. |
| 3 | `pnpm test` runs (even if no tests yet) | Run it. Exit code 0. |
| 4 | `pnpm lint` passes (biome check) | Run it. No errors. |
| 5 | `packages/shared` exports all types and they're importable | Build shared, then build daemon/cli (they import from `@autopod/shared`). |
| 6 | Daemon starts and responds to `GET /health` with 200 | Start daemon, `curl http://localhost:3100/health`. |
| 7 | CLI runs `ap --version` and prints version | `node packages/cli/dist/index.js --version` prints `0.0.1`. |
| 8 | SQLite migration runner creates all tables | After daemon starts once, check `autopod.db` has 6 tables. |
| 9 | CI workflow runs on push | `.github/workflows/ci.yml` exists and is valid YAML. |
| 10 | `docker compose config` validates | Run it. No errors. |

---

## Agent Instructions Summary

These are the hard rules for implementing this phase. Do not deviate.

1. **Start with `pnpm init` at root**, then configure workspaces in `pnpm-workspace.yaml`.
2. **Use tsup for building each package.** Do not use raw `tsc` output.
3. **Use nanoid for ID generation.** Wrapped in `@autopod/shared`'s `generateId()`.
4. **Use zod for schema validation.** All request/config schemas are Zod objects.
5. **The shared package has ZERO runtime dependencies beyond zod and nanoid.** No lodash, no utils, nothing.
6. **TypeScript paths**: packages reference each other via `@autopod/<name>` using pnpm `workspace:*` protocol. No `paths` mapping in tsconfig — pnpm workspace resolution handles it.
7. **Use `workspace:*` protocol** for internal deps in every package.json.
8. **Don't implement business logic.** Just scaffolding, types, and minimal "hello world" functionality. The daemon's only route is `/health`. The CLI's only command is `--version`.
9. **All files use ESM** (`"type": "module"` in package.json, `.js` extensions in imports within type files).
10. **Strict TypeScript** — `strict: true` is in `tsconfig.base.json`. Do not weaken it.

### Task Execution Order

These must be done sequentially — each depends on the previous:

1. Initialize monorepo root (pnpm, turbo, tsconfig.base, biome)
2. Create `packages/shared` with all types, schemas, errors, constants
3. Create `packages/daemon` scaffold with Fastify health endpoint + SQLite migration system
4. Create `packages/cli` scaffold with Commander + version command
5. Create `packages/validator` and `packages/escalation-mcp` scaffolds
6. Create `templates/base/` Dockerfiles
7. Create `docker-compose.yml` + `Dockerfile.daemon.dev`
8. Create `.env.example` + `.github/workflows/ci.yml`
9. Run all verification commands from Task 9
