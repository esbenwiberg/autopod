---
title: "Use daemon GitHub CLI authentication instead of profile PATs"
touches:
  - packages/shared/src/schemas/profile.schema.ts
  - packages/shared/src/types/profile.ts
  - packages/daemon/src/
  - packages/cli/src/commands/profile.ts
  - packages/desktop/
  - README.md
  - docs/
does_not_touch:
  - packages/daemon/src/actions/defaults/
  - packages/daemon/src/actions/policy-resolver.ts
  - packages/escalation-mcp/
  - packages/daemon/src/providers/
  - packages/daemon/src/runtimes/
require_sidecars: []
---

## Task

Make the single GitHub identity authenticated through `gh` under the Azure daemon service account the canonical GitHub credential for all GitHub-backed Autopod profiles. Eliminate operational dependence on per-profile `githubPat` values and remove GitHub PAT management from the normal CLI and Desktop profile experience, while preserving profile repository scope, action policies, approvals, sanitization, audit, and explicit workspace credential-injection boundaries.

## Motivation

The operator intends to use one dedicated, lower-privilege GitHub development user for all Autopod work and authenticate it once with GitHub CLI on the Azure daemon VM. Per-profile PAT entry and expiry management is unnecessary in that model and creates duplicated long-lived secret administration. Autopod already has a `GhPrManager` fallback that uses daemon-host `gh` authentication, but profile PATs remain the credential source for Git clone/fetch/push, GitHub action handlers, issue watchers, private reference repositories, warm-image maintenance, and workspace injection.

## Repository findings

- `packages/daemon/src/index.ts` selects `GitHubApiPrManager` whenever `profile.githubPat` exists and otherwise uses the daemon-host `GhPrManager`; the action-engine secret resolver also falls back to `profile.githubPat`.
- `packages/daemon/src/worktrees/local-worktree-manager.ts` deliberately disables ambient Git credential helpers. Preserve that fail-closed property: daemon Git operations must receive an explicit credential from a trusted daemon GitHub-auth abstraction, not silently inherit arbitrary host Git configuration.
- `packages/daemon/src/profiles/profile-pat.ts` and many `pod-manager.ts` call sites route Git operations through profile PATs.
- `packages/daemon/src/actions/handlers/github-handler.ts`, `packages/daemon/src/issue-watcher/`, `packages/daemon/src/pods/reference-repos.ts`, and `packages/daemon/src/images/warm-image-maintenance.ts` consume profile or environment GitHub tokens.
- `packages/daemon/src/pods/pod-manager.ts` explicitly injects profile PATs into interactive containers and best-effort authenticates `gh`. Injection is intentionally broader than brokered actions and must remain explicit rather than becoming automatic.
- GitHub PAT fields, expiry state, and presence indicators cross shared profile contracts, daemon persistence/redaction, CLI profile output/editing, and Desktop API/UI mappings.
- `docs/threat-model.md`, `docs/secrets-key.md`, and README guidance describe profile GitHub PAT storage and injection and must match the new authority.

## Approved approach

Introduce one daemon-level GitHub authentication abstraction backed by the installed and authenticated `gh` CLI. It must execute `gh` without a shell, treat token material as secret, never include token stdout in logs or errors, and produce an actionable failure identifying the daemon service account setup command when authentication is absent, malformed, or rejected.

Use this abstraction explicitly for every GitHub credential consumer:

1. Host worktree clone, fetch, pull, push, rebase, recovery, and approval flows.
2. GitHub PR creation, merge/status, review feedback, and GraphQL operations.
3. GitHub action-control-plane handlers while leaving policy checks, resource restrictions, approval, sanitization, quarantine, and append-only audit in their current authority.
4. GitHub issue watchers.
5. Private GitHub reference repositories selected from profiles.
6. GitHub-dependent warm-image maintenance.
7. Explicit `ap inject <pod> github` / `request_credential` flows.

Do not re-enable ambient host credential helpers. The implementation may use a securely obtained token with existing typed API clients and explicit Git credential plumbing; “backed by `gh`” does not require rewriting every API call as a `gh api` subprocess. Centralize acquisition so tests can inject a fake provider and production code does not repeatedly invent token handling.

For workspace injection, source the credential from daemon `gh` authentication only after the existing explicit human/client request. Do not automatically place it in any pod. Keep the warning boundary clear: an injected credential can be copied by the container and carries the dedicated development user's GitHub permissions.

Legacy `github_pat` and `github_pat_expires_at` database columns may remain temporarily to avoid a destructive migration and support rollback, but their values must not authorize any GitHub operation or silently serve as fallback. Remove GitHub PAT entry, expiry, and “configured PAT” status from current CLI/Desktop profile editing and ordinary profile presentation. API/schema compatibility may continue accepting legacy fields only when necessary for rolling clients, but they must be deprecated, redacted, ignored operationally, and documented as such. A legacy stored PAT must not mask missing daemon `gh` authentication.

Expose enough daemon GitHub-auth status to make configuration understandable without exposing token data: authenticated login when safely discoverable, unavailable/misconfigured state, and setup guidance. GitHub-backed work must fail before partial clone/push/action work when daemon authentication is unavailable. Do not make ADO-only work or daemon startup globally depend on GitHub authentication.

## Scope boundaries

### In scope

- One daemon GitHub identity shared by all GitHub profiles.
- Explicit, testable GitHub credential resolution through daemon-host `gh` authentication.
- Migration of all current profile-GitHub-PAT consumers.
- Removal of GitHub PAT management from normal profile CLI/Desktop UX.
- Compatibility treatment for legacy stored fields without operational fallback.
- Tests and operator/security documentation.

### Out of scope

- Multiple GitHub identities or per-profile GitHub accounts.
- GitHub App installation-token minting.
- ADO authentication changes.
- Copilot provider OAuth changes; `COPILOT_GITHUB_TOKEN` remains a separate model-provider credential contract.
- Pi runtime implementation.
- General session-capability/lease UX.
- Azure CLI, PIM, Supabase, or Vercel authentication changes.
- Removing action-policy resource checks or replacing daemon-side brokered actions with raw CLI access.

## Constraints

- Preserve `local-worktree-manager.ts` protections against prompts and ambient credential helpers.
- Never put a GitHub token in a command argument, remote URL, log field, error detail, persisted event, or profile response.
- Never call `gh auth token` through a shell or log its stdout/stderr unredacted.
- Keep GitHub action execution behind the existing ActionEngine policy, approval, sanitization, quarantine, and audit pipeline.
- Do not automatically inject GitHub credentials into managed or interactive pods.
- Missing `gh` binary, unauthenticated CLI state, malformed output, insufficient scope, and revoked credentials need distinct actionable failures where practical.
- Preserve ADO profile PAT behavior unchanged.
- Preserve existing profiles and database migration compatibility; do not delete encrypted legacy PAT data in this change.
- Update comments and names that incorrectly claim GitHub always comes from profile PATs.

## Observable acceptance behavior

1. A GitHub-backed pod with no profile GitHub PAT can clone, fetch, push, create and monitor a PR, and complete its normal lifecycle when the daemon service account has valid `gh` authentication.
2. A profile containing a legacy GitHub PAT still uses daemon `gh` authentication; changing or expiring the legacy PAT has no effect.
3. If daemon `gh` authentication is unavailable, GitHub-backed work fails clearly before partial work and does not fall back to the legacy PAT or ambient Git helpers.
4. GitHub action tools continue enforcing enabled actions, allowed resources, per-action approval, sanitization/quarantine, and audit while authenticating through the daemon identity.
5. GitHub issue watchers and private profile reference repositories work without a profile GitHub PAT.
6. GitHub credentials enter a workspace only after the existing explicit injection/request path; ordinary pod startup never injects them.
7. Profile CLI/Desktop no longer asks users to paste or maintain a GitHub PAT or expiry date and instead reports daemon GitHub-auth readiness without exposing secrets.
8. ADO behavior and Copilot authentication remain unchanged.

## Test expectations

- Add focused tests for the daemon GitHub-auth abstraction covering authenticated resolution, missing `gh`, unauthenticated state, empty/malformed secret output, cancellation/timeout as appropriate, and secret-safe errors/logging.
- Update worktree tests to prove explicit daemon credentials are used while ambient helpers remain disabled, and that legacy profile PATs cannot become fallback credentials.
- Update action-engine/GitHub-handler tests to prove the daemon source is used without weakening action-policy decisions or audit behavior.
- Update pod credential-injection tests to prove GitHub injection remains explicit and sources daemon auth; no startup path injects it automatically.
- Update issue-watcher, reference-repository, warm-image, PR-manager/factory, profile API, CLI, and Desktop tests affected by removal of the profile PAT authority and UX.
- Run targeted package suites plus the repository validation pipeline.

## Risks / pitfalls

- `gh` still manages an OAuth token underneath; this removes manual profile PAT management but does not eliminate token material. The dedicated GitHub user's permissions are the outer blast-radius boundary.
- Headless Linux `gh` storage may differ from macOS keychain behavior. Documentation must name the actual daemon service account and restrictive filesystem expectations.
- Calling `gh auth token` for every small API request may be wasteful, while indefinite caching may retain revoked credentials. Keep resolution centralized and choose bounded behavior with tests.
- A daemon-wide identity means profile isolation is enforced by Autopod policy and target repository validation, not separate GitHub accounts.
- Workspace injection grants the container the development user's effective GitHub permissions and cannot be strongly revoked merely by deleting a file.
- Removing public fields too aggressively can break rolling Desktop/CLI clients; preserving them operationally would violate the migration. Keep compatibility parsing separate from authority.

## Wrap-up

Before finishing:

1. Run focused daemon, CLI, shared, and Desktop tests for changed surfaces.
2. Run `./scripts/validate.sh` and report any environment-only limitation separately.
3. Update README and security/operator documentation with daemon-service-account `gh auth login` setup and migration behavior.
4. Confirm no test fixture or error output contains a real token-shaped value outside intentional sanitization fixtures.
5. Commit and push the implementation branch.
