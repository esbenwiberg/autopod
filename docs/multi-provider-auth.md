# Multi-Provider Model Authentication

## Context

The daemon currently requires an `ANTHROPIC_API_KEY` environment variable to inject into pods. This limits usage to Anthropic API key holders. We need to support **MAX/PRO** (Claude consumer OAuth subscriptions) and **Azure Foundry** deployments, following patterns proven in `esbenwiberg/orcha-v2`.

### Provider Types

| Provider | Auth Mechanism | Credential Source |
|----------|---------------|-------------------|
| `anthropic` (default) | API key in env var | Daemon env `ANTHROPIC_API_KEY` |
| `max` | OAuth credentials file | Per-profile, stored in DB |
| `foundry` | Foundry env vars | Per-profile, stored in DB |

---

## Architecture

### How MAX/PRO Works

Claude Code reads OAuth credentials from `~/.claude/.credentials.json` when no `ANTHROPIC_API_KEY` is set. The flow:

1. **Pre-flight refresh** — Before spawning agent, refresh the OAuth access token via `https://platform.claude.com/v1/oauth/token` if near expiry (5-min grace window)
2. **Temp HOME injection** — Write `.claude/.credentials.json` into the container, set `HOME` env var to point there
3. **Unset API key** — Omit `ANTHROPIC_API_KEY` from exec env to force Claude Code onto the OAuth path
4. **Post-exec persistence** — Read back refreshed tokens from the container (Claude rotates refresh tokens on use) and persist to DB

### How Foundry Works

Set env vars on exec: `CLAUDE_CODE_USE_FOUNDRY=1`, plus endpoint/project config. No credential file or token refresh needed.

### Backwards Compatibility

Profiles with no `modelProvider` field default to `'anthropic'` with daemon-level env var. Zero breakage for existing setups.

---

## Implementation Plan

### Phase 1: Type System & Schema (shared package)

**New file: `packages/shared/src/types/model-provider.ts`**

```typescript
export type ModelProvider = 'anthropic' | 'max' | 'foundry';

export interface AnthropicCredentials {
  provider: 'anthropic';
  // No fields — uses daemon env ANTHROPIC_API_KEY
}

export interface MaxCredentials {
  provider: 'max';
  accessToken: string;
  refreshToken: string;
  expiresAt: string;   // ISO datetime
  clientId?: string;    // defaults to well-known Claude OAuth client ID
}

export interface FoundryCredentials {
  provider: 'foundry';
  endpoint: string;     // Azure endpoint URL
  projectId: string;
  apiKey?: string;      // optional if using managed identity
}

export type ProviderCredentials = AnthropicCredentials | MaxCredentials | FoundryCredentials;
```

**Extend `Profile` type** (`packages/shared/src/types/profile.ts`):
- Add `modelProvider: ModelProvider | null` (null = default 'anthropic')
- Add `providerCredentials: ProviderCredentials | null` (null = use daemon env)

**Extend Zod schema** (`packages/shared/src/schemas/profile.schema.ts`):
- `modelProvider` as `z.enum(['anthropic', 'max', 'foundry']).nullable().default(null)`
- `providerCredentials` as a discriminated union on `provider` field, nullable

### Phase 2: Database Migration

**New file: `packages/daemon/src/db/migrations/008_model_provider.sql`**

```sql
ALTER TABLE profiles ADD COLUMN model_provider TEXT DEFAULT NULL;
ALTER TABLE profiles ADD COLUMN provider_credentials TEXT DEFAULT NULL;
```

Both nullable. `provider_credentials` is JSON text (same pattern as `escalation_config`, `action_policy`).

### Phase 3: Profile Store Updates

**File: `packages/daemon/src/profiles/profile-store.ts`**

- `rowToProfile()` — Map `model_provider` → `modelProvider`, parse `provider_credentials` JSON
- `create()` — Add to INSERT with `JSON.stringify` for credentials
- `update()` — Add dynamic UPDATE clauses for both new fields
- Inheritance — These fields follow default behavior (child overrides parent if non-null). No special merge logic.

### Phase 4: Provider Layer (core new code)

**New directory: `packages/daemon/src/providers/`**

#### `types.ts` — Internal interfaces

```typescript
export interface ProviderEnvResult {
  env: Record<string, string>;
  containerFiles: Array<{ path: string; content: string }>;
  requiresPostExecPersistence: boolean;
}
```

#### `env-builder.ts` — Main orchestrator

```typescript
export async function buildProviderEnv(
  profile: Profile,
  sessionId: string,
  logger: Logger,
): Promise<ProviderEnvResult>
```

Strategy based on `profile.modelProvider ?? 'anthropic'`:

- **`anthropic`**: Return `{ ANTHROPIC_API_KEY }` from daemon env. No files. No persistence.
- **`max`**: Refresh token → build `.claude/.credentials.json` → return env without API key. Persistence required.
- **`foundry`**: Return `{ CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_FOUNDRY_ENDPOINT, CLAUDE_FOUNDRY_PROJECT }` plus optional API key. No persistence.

#### `credential-refresh.ts` — OAuth token refresh

```typescript
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export async function refreshOAuthToken(
  credentials: MaxCredentials,
  logger: Logger,
): Promise<MaxCredentials>
```

- Skip refresh if token valid for >5 minutes
- POST with `grant_type=refresh_token`
- Retry once on 5xx
- Throw clear errors for 401/403 (token revoked, needs re-auth)

#### `credential-persistence.ts` — Post-exec token readback

```typescript
export async function persistRefreshedCredentials(
  containerId: string,
  containerManager: ContainerManager,
  profileStore: ProfileStore,
  profileName: string,
  logger: Logger,
): Promise<void>
```

- Read `.claude/.credentials.json` from container
- Optimistic locking: only overwrite if new token has later `expiresAt`
- Non-fatal on failure (session still succeeded)

### Phase 5: ContainerManager `readFile` Method

**File: `packages/daemon/src/interfaces/container-manager.ts`**

Add `readFile(containerId: string, path: string): Promise<string>` to interface.

**File: `packages/daemon/src/containers/docker-container-manager.ts`**

Implement via `container.getArchive({ path })` → extract tar → return file content.

### Phase 6: Session Manager Integration

**File: `packages/daemon/src/sessions/session-manager.ts`**

**Replace hardcoded secretEnv (lines 239-246):**

```typescript
// Build provider-aware env
const providerResult = await buildProviderEnv(profile, sessionId, logger);
const secretEnv: Record<string, string> = {
  SESSION_ID: sessionId,
  ...providerResult.env,
};

// Fallback to daemon env if no provider configured
if (session.runtime === 'claude' && !secretEnv.ANTHROPIC_API_KEY
    && !providerResult.containerFiles.length && process.env.ANTHROPIC_API_KEY) {
  secretEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
}
if (session.runtime === 'codex' && !secretEnv.OPENAI_API_KEY && process.env.OPENAI_API_KEY) {
  secretEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
}
```

**Write credential files before exec:**

```typescript
for (const file of providerResult.containerFiles) {
  await containerManager.writeFile(containerId, file.path, file.content);
}
```

**Post-exec credential persistence** (after agent completes, before cleanup):

```typescript
if (providerResult.requiresPostExecPersistence) {
  await persistRefreshedCredentials(containerId, containerManager, profileStore, profileName, logger);
}
```

**Resume calls need env too** — Extend `Runtime.resume()` to accept optional env. Every resume call must run `buildProviderEnv()` first since tokens may have rotated. Extract helper: `getSessionProviderEnv(session)`.

### Phase 7: Network Policy

For MAX provider, containers need to reach `platform.claude.com` (Claude CLI refreshes tokens internally). Add to `DEFAULT_ALLOWED_HOSTS` in network config.

For Foundry, dynamically add the configured endpoint hostname to allowed hosts.

---

## Edge Cases & Failure Modes

| Scenario | Behavior |
|----------|----------|
| Expired refresh token, can't re-auth | Session fails at provision with clear error. User must re-configure creds. |
| Concurrent sessions stomping refresh tokens | Optimistic locking — latest `expiresAt` wins. Worst case: one token lost, next session re-refreshes. |
| Container dies before credential readback | Tokens lost. Next session uses pre-exec token. If already rotated server-side, refresh fails → user re-auths. |
| Profile inheritance with mismatched provider/creds | Env-builder validates `credentials.provider` matches `modelProvider`, throws on mismatch. |
| No provider configured (existing profiles) | Falls back to daemon env vars. Zero breakage. |

---

## Dependency Graph

```
Phase 1 (types/schema) ─┐
                         ├─> Phase 3 (profile-store) ─┐
Phase 2 (migration)     ─┘                             │
                                                        ├─> Phase 6 (session-manager)
Phase 4 (provider layer) ───────────────────────────────┤
                                                        │
Phase 5 (readFile on ContainerManager) ─────────────────┘

Phase 7 (network policy) — independent
```

## Verification

1. **Unit tests** for env-builder (all 3 provider paths + fallback), credential-refresh (mock HTTP), credential-persistence (mock readFile + optimistic locking), profile-store (new columns + inheritance)
2. **Integration tests** for session-manager: MAX session writes credential file + no API key in env, Foundry session has correct env vars, default session uses daemon env
3. **Manual E2E** with real MAX/PRO credentials to verify token refresh + rotation + persistence cycle

## Key Files

| File | Change |
|------|--------|
| `packages/shared/src/types/model-provider.ts` | **New** — Provider types & credential shapes |
| `packages/shared/src/types/profile.ts` | Add `modelProvider`, `providerCredentials` |
| `packages/shared/src/schemas/profile.schema.ts` | Zod validation for new fields |
| `packages/daemon/src/db/migrations/008_model_provider.sql` | **New** — DB migration |
| `packages/daemon/src/profiles/profile-store.ts` | Column mapping, CRUD for new fields |
| `packages/daemon/src/providers/types.ts` | **New** — ProviderEnvResult interface |
| `packages/daemon/src/providers/env-builder.ts` | **New** — Provider-aware env building |
| `packages/daemon/src/providers/credential-refresh.ts` | **New** — OAuth token refresh |
| `packages/daemon/src/providers/credential-persistence.ts` | **New** — Post-exec token readback |
| `packages/daemon/src/interfaces/container-manager.ts` | Add `readFile` method |
| `packages/daemon/src/containers/docker-container-manager.ts` | Implement `readFile` via getArchive |
| `packages/daemon/src/sessions/session-manager.ts` | Replace secretEnv, add pre/post hooks |
| `packages/shared/src/types/runtime.ts` | Extend `resume()` with optional env |
| `packages/daemon/src/runtimes/claude-runtime.ts` | Pass env on resume |
