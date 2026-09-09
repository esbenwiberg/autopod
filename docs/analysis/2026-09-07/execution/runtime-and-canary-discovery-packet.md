# Runtime, image and historical-error metadata proposal

Status update: this exact payload was approved and executed once in [checkpoint 109](checkpoint-109.md). Its request is fulfilled. The original proposal text below is preserved as dated scope; [the targeted prerequisite packet](targeted-acceptance-prerequisites.md) contains the new, separate request.

The checkpoint-107 approved actions are complete: the sampled restore passed and its temporary copy was removed; all four authenticated routes returned 200. This is a separate, proposed metadata read to resolve the next prerequisites. **It has not run and is not yet approved.**

[Exact payload](fixtures/inspect-runtime-and-canary-metadata.py), SHA-256 pinned in [the manifest](receipts/checkpoint-108-discovery-manifest.json). Three local tests verify selected-environment filtering, suppression of registry credentials/query strings, and bounded image/label validation. No production environment or profile data was used in those tests.

## Target and bounds

Use the same Azure VM `autopod-daemon`, resource group `ewi-sandboxes`, subscription `06bb959b-9458-41a6-bdf5-77cc12feaab9`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`, through Azure Run Command. Recheck VM identity before one invocation. Limit guest work to 60 seconds and output to 3,500 bytes, with explicit omission counts. No service restart, deployment, sandbox allocation, provider invocation or resource configuration change. Estimated added provider/sandbox spend: **$0**.

## Precisely requested metadata

1. Service PID and allowed release working directory; current checkout SHA/dirty boolean if available; SHA-256 of `dist/index.js` under that working directory, reading at most 8 MiB. These are on-disk observations, not an attestation of every resident or dynamically loaded byte.
2. Host Node version from `/proc/<service-pid>/exe --version`, bounded to ten seconds. This does not start an agent, run a provider CLI or prove the sandbox runtime version.
3. Read at most 64 KiB of the service process's environment **in memory only**. Export only the validated values of `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_SANDBOX_GROUP`, `SANDBOX_GROUP`, `AZURE_SANDBOX_LOCATION`, `AZURE_LOCATION`, `AZURE_SANDBOX_TIER`, `SANDBOX_TIER`, and the normalized credential-free `.azurecr.io` hostname from `ACR_REGISTRY_URL`. Never export the raw environment, authentication keys, passwords, tokens or registry credentials. Invalid/unbounded values become unavailable.
4. Only if `/data/autopod/autopod.db` still matches device/inode `2049/13107203` and a service descriptor: a read-only projection of at most 20 profile names, inheritance names, execution targets, runtime labels and warmed-image references. These values are bounded and validated before output. Do not select repository URLs, task text, prompts, credentials, provider-account secrets or other profile fields. Record inventory/transport omissions; do not infer inherited values when the required parent is missing.
5. Fixed error classifications, bounded timestamps and endpoint categories from the service journal for **September 7, 00:00–24:00 UTC**: at most 10,000 lines, 2 MiB and ten seconds; at most 30 retained matching errors before the transport cap. Use the same fixed SQLite/JSON/disk classification filter as the earlier approved metadata inspection. No raw log, stack, SQL identifier, arbitrary error text or row content leaves the VM. No matching errors, missing journals or truncated output do not prove the historical root cause.

## Why these fields are needed

A read-only Azure resource inventory found three groups: `sandbox-group-ewi1` and `autopod-spike` in Sweden Central, and `autopod-spike-neu` in North Europe. The repository default is not proof of the hosted configuration. The selected configuration/profile metadata will identify the actual image and target for digest resolution, pricing and the required canary proposal. It will not authorize that canary.

The sampled backup's 48-table schema/watermark signatures match the active database and current APIs are healthy. The historical broad API failure still lacks proven cause. The September 7 bounded journal is the next targeted source of evidence; current success is not substituted for a diagnosis.

After this read, finish the exact image/digest/tier/command/oracle/spend packet before requesting the required actual-image canary. Visible native interaction remains a separate platform prerequisite. No publication, deployment, restart, paid canary or native acceptance is implied by approving this metadata scope.
