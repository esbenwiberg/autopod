# Slice 17 research: validation environment preparation

Date: 2026-10-18. Branch: codex/pod-manager-workspace.
Baseline: 321ceb07d13f459242289a2f069b49e5e2ddf754.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
State: Planning only. No product/test changes or implementation tests run.

## Current behavior

packages/daemon/src/pods/pod-manager.ts is 16,635 lines. Its complete
validationEnvironmentForPod definition is at :1906–1942 (37 lines).
It reads deps.launchConfiguration live. With no saved launch, it returns
buildValidationExecEnv(profile.privateRegistries, profile.registryPat ?? null,
profile.buildEnv), without file writes, capability checks or credential resolution.
This helper itself does not reject a missing launch digest; executionForPod in
some callers retains its separate SNAPSHOT_CORRUPT check.

With a launch, it calls the manager's executionCredentialsFor(launch), then awaits
an optional live assertCurrentCapabilities(launch). executionCredentialsFor :1893
throws SECRET_EXECUTION_ADAPTER_REQUIRED/503 if the live service has no credential
adapter and the admitted launch references any credentials. Otherwise its undefined
result permits the existing profile-env fallback, using a null registry PAT.
That fallback has one capability check and no file writes or second check.

With an adapter, credentials.buildEnvironment(launch) is invoked before
credentials.registries(launch) in Promise.all. Both results must resolve before
container lookup/writes. The selected adapter object is held across the first await;
its methods are looked up when Promise.all is constructed. A rejected Promise.all
does not cancel its sibling. Synchronous throws retain normal argument-evaluation
behavior. No catch, retry or transaction exists in this helper.

If pod.containerId is truthy after material resolution, lookup uses the captured
containerManagerFactory.get(pod.executionTarget). registry.files are written in
array order, followed by optional registry.nugetSecret, all with mode0600. An empty
file list still performs the manager lookup when a container exists. No chmod or
credential-provider installation occurs here. Earlier writes remain if a later
write or capability check fails. Without a container, material lookup, final
capability check and env construction still occur.

A second live optional capability call follows writes. Its lookup can see a changed
or removed deps.launchConfiguration service; the original launch stays the argument.
Return spreads buildValidationExecEnv([], null, env) then a NuGet envFileKey/path
mapping if present. That final mapping overrides a colliding build-env value.
There is no new snapshot read after awaits. The pod/profile objects are original
references rather than clones; late pod.containerId/target reads remain late.

## Callers and collaborators

Two direct external calls remain in manager: forced revalidation :13871 and public
getValidationEnvironment :14755. Two shorthand captures remain: worker runtime
credentials composition :5024 and validation inputs composition :5121. Their
existing modules call this callback before worker auth preparation or diff/log work.
No callback signature/caller/catch/lifecycle ownership needs to change.

executionCredentialsFor has five other direct calls in manager: runtime priming
:3060, provisioning :7349/:7474, deployment :14764 and injected MCP :14779,
plus its call in this helper (six total). It must stay
in manager. executionForPod and injectionsForPod likewise remain there.
LaunchExecutionCredentials stays imported in manager for the dependency interface.
buildValidationExecEnv is otherwise used only inside the extraction target, so only
that named import leaves the manager's existing registry-injector import group.

registry-injector.ts defines telemetry/default/env precedence. runtime-env.ts adds
six non-secret telemetry defaults, then caller entries. Legacy buildEnv can override
the inferred NuGet file pointer. Launch material uses createLaunchExecutionCredentials
in configuration/execution-credentials.ts and resolveLaunchValues in
configuration/credential-references.ts: each purpose resolves current credentials
under admitted id/createdAt/purpose/origin scope without putting secret values in
the saved snapshot. npm and NuGet use separate tokens where configured. Those
modules and credential policy remain outside extraction scope.

## Existing evidence and patterns

configuration/components.test.ts exercises the public manager environment method
with real composed admission/credential services, rotation, npm mode0600 writes,
no chmod/chown and unchanged snapshot digest. It is not in the predecessor affected
list and should be added explicitly. configuration/credential-store.test.ts covers
actual encrypted storage, rotation/revocation, purpose separation and launch
materialization. registry-injector.test.ts covers env/file generation separately.

pod-manager.test.ts has validation inputs compatibility (:27368), validation
execution compatibility (:27811), worker runtime credential compatibility (:30192).
The last group's launch case (:30573) exercises the callback during sendMessage;
its third capability rejection belongs to the outer worker helper. Slice17 must
add explicit first/second validation-env check characterization, rather than
misreport the existing third check as this helper's final check.
Forced revalidation Path2 (:22765) and reserved context overlay (:27591) already
exercise callers' env/context merge behavior.

## Constraints and next action

Isolated checkout is clean at baseline. Primary checkout has unrelated product
changes; leave them untouched. Existing three-phase approval covers a whole slice
once approved. Preserve original bodies, arguments, dependency receivers and live
lookup timing. No provider/network/Docker calls are required for local proof.
Existing 84-suite affected list lives in
.autopod-data/worker-runtime-credentials/affected-command.json.
Plan can add the new direct suite and verified components.test.ts (86 total).
Node22.23.3/pnpm9.15.4/SQLite3.49.2 and the process-only qualification adjustments
from Slice16 remain the established harness; recheck actual versions when running.

Next: present the illustrated plan and await explicit approval before implementation.
No unresolved product choice remains. Counts above describe source and planned scope,
not implementation results.
