# Brief 04: Daemon — placement field + container factory routing

## Objective

Add `placement` to profiles + sessions, route the container factory based
on placement, and migrate existing `executionTarget` data forward without
breaking the legacy field.

## Dependencies

Briefs 01, 03.

## Blocked By

Brief 03 (needs `RemoteContainerManager` to route to).

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/db/migrations/039_placement.sql` | create | `ALTER TABLE profiles ADD COLUMN placement TEXT; ALTER TABLE sessions ADD COLUMN placement TEXT;` |
| `packages/shared/src/types/profile.ts` | modify | Add `placement: Placement \| null` to `Profile`; keep `executionTarget` as `@deprecated` |
| `packages/shared/src/types/session.ts` | modify | Add `placement: Placement \| null` to `Session` + `CreateSessionRequest` |
| `packages/daemon/src/profiles/profile-validator.ts` | modify | Zod schema for `placement` union |
| `packages/daemon/src/profiles/profile-store.ts` | modify | Serialize/deserialize `placement` as JSON |
| `packages/daemon/src/sessions/session-repository.ts` | modify | Serialize/deserialize `placement` as JSON |
| `packages/daemon/src/index.ts` | modify | Extend `containerManagerFactory` to route `placement.kind === 'runner'` to a new `RemoteContainerManager` |
| `packages/daemon/src/containers/container-manager-factory.ts` | create | Extract the factory from `index.ts` into a dedicated file; `get(placement: Placement): ContainerManager` |

## Interface Contracts

```ts
export interface ContainerManagerFactory {
  get(placement: Placement): ContainerManager;
}
```

Resolution order in `session-manager.ts`:
1. If `session.placement` set → use it.
2. Else if `profile.placement` set → use it.
3. Else convert legacy `profile.executionTarget`:
   `'local' → { kind: 'local-docker' }`, `'aci' → { kind: 'aci' }`.

## Implementation Notes

- Migration must be safe to run on existing DBs — column added as nullable,
  no default. No data migration (legacy `executionTarget` stays source of
  truth until user updates profile).
- Factory receives the `RunnerRegistry` at construction; for `runner` kind
  it instantiates a `RemoteContainerManager` per call (or caches them per
  runnerId — trivial map, no lifecycle needed since they're stateless apart
  from the connection reference).
- Profile Zod schema rejects unknown `placement.kind` values.
- Session-manager logs which target was chosen at `provisioning` entry with
  the reason (explicit session override vs profile default vs legacy
  fallback).
- Write one unit test in `container-manager-factory.test.ts` for each
  placement kind.

## Acceptance Criteria

- [ ] Migration `039_placement.sql` applies cleanly.
- [ ] `Profile.placement` round-trips through `profile-store` intact.
- [ ] `Session.placement` round-trips through `session-repository` intact.
- [ ] Factory routes `local-docker` → `DockerContainerManager`.
- [ ] Factory routes `aci` → `AciContainerManager`.
- [ ] Factory routes `runner:<id>` → `RemoteContainerManager` bound to that
  id.
- [ ] Legacy profile with `executionTarget = 'local'` and no `placement`
  still routes to Docker.
- [ ] Legacy profile with `executionTarget = 'aci'` and no `placement`
  still routes to ACI.
- [ ] `session.placement` overrides `profile.placement` when both set.
- [ ] Validator rejects `{ kind: 'bogus' }` with a clear error.
- [ ] Existing session-lifecycle e2e tests still pass unchanged.

## Estimated Scope

Files: 2 created + 6 modified | Complexity: medium
