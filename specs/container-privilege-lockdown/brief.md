# Brief: Container Privilege Lockdown

## Objective

Close the primary privilege-escalation path inside autopod session containers — the
"agent → sudo/setuid → root → `iptables -F OUTPUT`" chain — so a prompt-injected
or malicious agent cannot flush egress restrictions and reach arbitrary hosts.

The fix is layered:
1. **Kernel-enforced**: enable `no-new-privileges` on every spawned container — blocks
   setuid binaries from escalating, kernel-level, no userspace bypass.
2. **Image hygiene**: verify no base image installs `sudo` or grants `autopod` membership
   in `sudo`/`wheel` groups. Lock that invariant in via an automated check.
3. **Regression guard**: confirm Playwright / Chromium still launches inside the
   hardened container (the main thing `no-new-privileges` can break in practice).

The decorative `capsh --drop=cap_net_admin` suggested in the original proposal is
**explicitly dropped from scope** — each `docker exec` gets fresh caps from container
config regardless of what any prior in-container process did to its own bounding set,
so the drop is cosmetic. Adding `libcap2-bin` to images for a cosmetic check is not
worth the image-size/complexity tax.

A follow-up ADR documents the *truly* airtight fix (host-side firewall via `nsenter`,
dropping `NET_ADMIN` from the container config entirely) as deferred work.

## Files

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/containers/docker-container-manager.ts` | modify | Add `SecurityOpt: ['no-new-privileges:true']` to `hostConfig` in `spawn()`. Applies to ALL containers — place it unconditionally, not inside the `if (config.networkName)` block. |
| `packages/daemon/src/containers/docker-container-manager.test.ts` | modify | Two new tests: `SecurityOpt` is set when `networkName` is absent; `SecurityOpt` is set when `networkName` is present. |
| `packages/daemon/src/containers/playwright-sandbox.integration.test.ts` | create | New Vitest integration test (skipped if Docker unavailable) that spawns a node22-pw container with `no-new-privileges`, execs `chromium --version` (or a Playwright `chromium.launch().close()` one-liner) as `autopod`, asserts non-zero launch. Guards against the SUID-sandbox regression. |
| `scripts/check-base-images.sh` | create | Tiny shell script: grep all four `templates/base/Dockerfile.*` for forbidden patterns (`apt-get install.*\bsudo\b`, `usermod.*-aG.*sudo`, `usermod.*-aG.*wheel`, `gpasswd.*sudo`). Exit non-zero if any match. |
| `scripts/validate.sh` | modify | Add a `./scripts/check-base-images.sh` invocation before the lint step so CI enforces the no-sudo invariant. |
| `docs/proposals/9-nsenter-host-side-firewall.md` | create | ADR for the deferred airtight fix — host-side firewall via `nsenter`, drop `NET_ADMIN` from container config, rework `refreshFirewall` to operate on the host's view of the container's netns. Captures why it's deferred and when to pick it up. |

**Not modified**: `docker-network-manager.ts` (no capsh drop), the four base Dockerfiles
(no `libcap2-bin`, no sudo present today, no change needed), `AciContainerManager`
(ACI uses different API, not affected — separate follow-up if needed).

## Approach

### 1. Kernel flag (`docker-container-manager.ts`)

In the `spawn()` method (`docker-container-manager.ts:56-63`), add `SecurityOpt` to
`hostConfig` unconditionally, BEFORE the `if (config.networkName)` block:

```ts
const hostConfig: Record<string, unknown> = {
  Binds: binds.length > 0 ? binds : undefined,
  PortBindings: Object.keys(portBindings).length > 0 ? portBindings : undefined,
  AutoRemove: false,
  Memory: config.memoryBytes ? Math.ceil(config.memoryBytes / 4096) * 4096 : undefined,
  // Kernel-enforced: execve() cannot grant new privileges. Neutralizes setuid
  // binaries (sudo, su, mount, pkexec) so the agent cannot chain autopod → root
  // → iptables -F. Applies regardless of network_policy — the threat exists
  // even without a firewall to flush.
  SecurityOpt: ['no-new-privileges:true'],
};
```

### 2. Unit tests (`docker-container-manager.test.ts`)

Extend the existing `spawn` describe block with two tests. Mirror the patterns already
at `docker-container-manager.test.ts:180-189`:

```ts
it('sets no-new-privileges on containers without network isolation', async () => {
  await manager.spawn(baseConfig);
  const createCall = docker.createContainer.mock.calls[0]?.[0];
  expect(createCall.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
});

it('sets no-new-privileges on network-isolated containers', async () => {
  await manager.spawn({ ...baseConfig, networkName: 'autopod-net' });
  const createCall = docker.createContainer.mock.calls[0]?.[0];
  expect(createCall.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
});
```

### 3. Playwright regression test (`playwright-sandbox.integration.test.ts`)

New file. Use Vitest's conditional `describe.skipIf` pattern (check `process.env.DOCKER_AVAILABLE`
or attempt `docker.ping()` once and skip if it fails — match whatever `docker-validate.sh`
already sets up).

Test body:
1. Build or pull the `node22-pw` image (use the tag autopod already uses)
2. Create a container with `SecurityOpt: ['no-new-privileges:true']`, `User: 'autopod'`
3. `docker exec` a tiny Node one-liner:
   ```js
   import { chromium } from 'playwright';
   const b = await chromium.launch();
   await b.close();
   console.log('ok');
   ```
4. Assert exit code 0 and stdout contains `ok`

If Chromium falls back to SUID sandbox (which `no-new-privileges` blocks), the launch
fails and this test goes red — exactly the regression we want to catch.

Time budget: 60s. Mark with `testTimeout: 60_000` and retry once (Playwright launches
are occasionally flaky in CI).

### 4. Base image invariant check (`check-base-images.sh` + `validate.sh`)

New script — single responsibility, no fancy logic:

```sh
#!/usr/bin/env bash
set -euo pipefail

FORBIDDEN_PATTERNS=(
  'apt-get install.*\bsudo\b'
  'apt install.*\bsudo\b'
  'usermod.*-aG.*\bsudo\b'
  'usermod.*-aG.*\bwheel\b'
  'gpasswd.*\bsudo\b'
  'gpasswd.*\bwheel\b'
)

FAIL=0
for file in templates/base/Dockerfile.*; do
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -E "$pattern" "$file" >/dev/null; then
      echo "FAIL: $file matches forbidden pattern: $pattern"
      FAIL=1
    fi
  done
done

if [ $FAIL -ne 0 ]; then
  echo ""
  echo "Base images must not install sudo or grant sudo/wheel group membership."
  echo "See specs/container-privilege-lockdown/brief.md for the rationale."
  exit 1
fi

echo "Base image invariant check passed."
```

Add to `scripts/validate.sh` as the first step (cheapest to fail, runs before anything
slow). Confirm it passes cleanly on current images before committing.

### 5. Deferred ADR (`docs/proposals/9-nsenter-host-side-firewall.md`)

Structure:
- **Context**: Why `no-new-privileges` handles the realistic attack paths (setuid chain)
  but does NOT handle a kernel-exploit-level container escape. The container still has
  `NET_ADMIN` in its capability bounding set; a kernel CVE that grants in-container
  root bypasses the no-new-privs check and regains `NET_ADMIN`.
- **Proposal**: Move firewall management host-side. Daemon calls `nsenter --target <pid>
  --net iptables …` (or nftables) against the container's network namespace, from a
  process running on the host with its existing privileges. Container config drops to
  `CapAdd: []` — no `NET_ADMIN` ever granted to anything inside the container.
  `refreshFirewall` becomes a host-side operation.
- **Consequences**:
  - Daemon already has effectively root-equivalent privilege (it talks to the Docker
    socket); using `NET_ADMIN` host-side is not a new trust grant.
  - Live policy updates still work, via host-side exec instead of in-container exec.
  - `AciContainerManager.refreshFirewall()` already no-ops — no ACI change needed.
  - Base images no longer need `iptables` / `ipset` / `dnsmasq` — possible image slim
    opportunity (non-goal of the ADR, flag for follow-up).
- **Why deferred**: effort (≈1 week — rework `refreshFirewall`, rewrite firewall script
  to run host-side, validate DNS-based allowlisting still works when iptables is host-side
  but dnsmasq is in-container, or move dnsmasq host-side too). The residual threat
  (in-container kernel CVE) is real but mitigated by `no-new-privileges` blocking the
  easy setuid paths. Revisit when either a relevant kernel CVE drops or threat model
  explicitly requires "assume arbitrary in-container code execution as root."

## Edge cases

- **Older Docker (<20.10)**: `no-new-privileges:true` format is correct for modern Docker.
  Autopod already requires a modern Docker for other features. No back-compat shim.
- **Host with user namespaces disabled**: Chromium's namespace sandbox fails. With
  `no-new-privileges`, SUID fallback also fails. Playwright can't launch. The regression
  test catches this. Document in README / validator docs if detected. Workaround: users
  can enable user namespaces on their Docker host, OR accept that network-isolated
  profiles can't run Playwright on that host.
- **Custom profile images**: inherit `no-new-privileges` automatically (set host-side).
  If the custom image installs sudo, that's the user's choice — `no-new-privileges`
  still blocks escalation via it, so it's functionally defanged regardless.
- **`refreshFirewall` mid-session**: completely unaffected. Each `docker exec` gets caps
  from container config (which still has `NET_ADMIN` for network-isolated profiles).
  Verified — no test changes needed for existing live-refresh tests.
- **Workspace pods**: use the same `DockerContainerManager.spawn()`, automatically
  hardened. No workspace-specific code change.
- **ACI containers**: ACI's own sandboxing model. This spec does not touch them.
  If ACI also needs hardening, separate spec.

## Implementation notes

- **Do NOT add `libcap2-bin` to base images** — the capsh drop is dropped from scope.
- **Do NOT modify `docker-network-manager.ts`** — no capsh append.
- **Order of commits suggested**:
  1. `check-base-images.sh` + `validate.sh` — defensive, establishes the invariant
     before anything else in this series lands.
  2. Kernel flag change + unit tests.
  3. Playwright integration test.
  4. ADR for deferred nsenter work.
- **Biome style**: 2-space indent, 100-char lines, single quotes, trailing commas.
- **Script style**: `set -euo pipefail`, no bashisms that break on dash.

## Acceptance criteria

- [ ] Every container spawned by `DockerContainerManager.spawn()` has
      `SecurityOpt: ['no-new-privileges:true']` in `HostConfig`, regardless of whether
      network isolation is enabled. Verified by unit tests.
- [ ] `refreshFirewall` still successfully modifies iptables on a running container
      after this change (existing tests remain green).
- [ ] Playwright integration test launches Chromium successfully in a
      `node22-pw` container with `no-new-privileges`. Test is skipped gracefully when
      Docker is unavailable.
- [ ] `scripts/check-base-images.sh` exits 0 on current base images, exits non-zero
      when fed a Dockerfile that contains any forbidden pattern (verify with a throwaway
      fixture during manual testing).
- [ ] `scripts/check-base-images.sh` runs as the first step of `scripts/validate.sh`.
- [ ] `docs/proposals/9-nsenter-host-side-firewall.md` exists with context, proposal,
      consequences, and deferral rationale sections.
- [ ] `./scripts/validate.sh` passes (lint + build + test all green, including the new
      base-image check).
- [ ] **Manual verification**: exec into a live session container as `autopod`, attempt
      to escalate via `sudo su` (if sudo were present) or a crafted setuid-root
      `chmod u+s /bin/bash`-style test (requires pre-placing the setuid bit as root via
      `docker exec -u root`). Verify escalation fails. Document result in PR body.

## Estimated scope

Files: 6 (1 code, 1 test modify, 1 test create, 2 script, 1 doc) | Complexity: low-medium | Time: 2-3 hrs

The Playwright integration test is the long pole if it needs a real image build; the
rest is mechanical.
