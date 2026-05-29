---
title: "Force Codex ChatGPT egress hosts"
touches:
  - packages/daemon/src/pods/runtime-network-defaults.ts
  - packages/daemon/src/pods/runtime-network-defaults.test.ts
does_not_touch:
  - packages/daemon/src/containers/docker-network-manager.ts
  - packages/daemon/src/containers/haproxy-config.ts
  - packages/shared/src/types/
  - packages/shared/src/schemas/
  - packages/desktop/
  - packages/daemon/src/db/migrations/
---

## Task

Make Codex/OpenAI pods always include the ChatGPT hostnames required for Codex
remote compaction when network isolation is enabled. This must apply even when a
profile uses `networkPolicy.replaceDefaults: true`, because remote compaction is
runtime-provider egress rather than optional browsing or package access.

Do not add the literal compaction URL path to any allowlist. The restricted-mode
firewall is hostname/SNI based, so `https://chatgpt.com/backend-api/codex/responses/compact`
is represented by the `chatgpt.com` host.

## Why

Codex pods can fail during remote compaction with:
`Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)`.
For profiles that replace default egress hosts, the current runtime network
default helper returns early and does not restore the ChatGPT hosts Codex needs.

The fix keeps Codex compaction resilient without broadening access to unrelated
domains such as GitHub.

## Touches

Modify `packages/daemon/src/pods/runtime-network-defaults.ts` so Codex/OpenAI
runtime-required ChatGPT hosts are added even when `replaceDefaults` is true.
Update `packages/daemon/src/pods/runtime-network-defaults.test.ts` to lock that
behavior.

## Does not touch

Do not modify `packages/daemon/src/containers/docker-network-manager.ts`; the
global default allowlist is already correct and should continue to exclude GitHub
from defaults. Do not modify `packages/daemon/src/containers/haproxy-config.ts`
or HAProxy timeouts in this task.

Do not change shared profile types, shared schemas, desktop profile UI, or
database migrations. Do not add `github.com` or `api.github.com` as forced Codex
hosts.

## Constraints

`runtime-network-defaults.ts` currently has one `CODEX_REQUIRED_HOSTS` list that
contains `chatgpt.com`, `*.chatgpt.com`, `github.com`, and `api.github.com`, and
returns early on `policy.replaceDefaults`. Split that behavior so only the two
ChatGPT hosts are provider-required under replaced defaults.

`docker-network-manager.ts` intentionally does not include GitHub in global
defaults:

> Including github.com lets agents bypass ACP action tools via WebFetch/curl to GitHub
> web pages.

Preserve that security boundary. GitHub hosts must remain profile-controlled.

## Skills to reference

None. This task does not touch `Profile`, `PodStatus`, `state-machine.ts`, or
any database migration.

## Test expectations

Update `runtime-network-defaults.test.ts` with a regression case for a Codex or
OpenAI-surface pod whose policy is `enabled: true`, `mode: "restricted"`, and
`replaceDefaults: true`. Assert the result still contains `chatgpt.com` and
`*.chatgpt.com`, preserves the existing custom host, and does not contain
`github.com` or `api.github.com`.

Update the existing Codex defaults test so it no longer expects GitHub hosts to
be auto-added by this helper. Keep the existing non-Codex Anthropic no-op test.

## Risks / pitfalls

Do not put URL paths in `allowedHosts`; the schema only accepts hostnames/IPs and
HAProxy only sees TLS SNI. Adding `/backend-api/codex/responses/compact` would
be invalid and would not solve the issue.

Be careful not to remove `chatgpt.com` or `*.chatgpt.com` from
`DEFAULT_ALLOWED_HOSTS`; those defaults are still correct for profiles that do
not replace defaults. This task only changes the runtime override for replaced
defaults.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
