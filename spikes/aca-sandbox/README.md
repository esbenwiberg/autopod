# Spike: Azure Container Apps **Sandboxes** feasibility probe

> **Status:** throwaway feasibility spike. This does **not** touch the daemon and is
> **not** a `ContainerManager` implementation. Its only job is to answer "should we
> build an `executionTarget: 'sandbox'` backend?" by exercising the preview product
> against the four unknowns we flagged.

## Why this exists

We already have two execution backends behind `ContainerManager`
(`packages/daemon/src/interfaces/container-manager.ts`):

- **Docker** (`local`) — `docker-container-manager.ts`
- **ACI** — `aci-container-manager.ts`

Azure Container Apps **Sandboxes** (public preview, `Microsoft.App/SandboxGroups`)
looks like a strictly-better Azure backend than ACI: BYO OCI image, microVM
isolation, snapshot suspend/resume, sub-second start, scale-to-zero, and — the
standout — a **per-sandbox egress policy that is mutable at runtime**, which maps
directly onto our `allow-all` / `deny-all` / `restricted` modes and
`refreshFirewall()`.

But it's **preview**, the SDK is early-access, and the docs are login-gated. Before
writing an ADR or a backend, confirm the platform actually behaves.

## The four unknowns this probe answers

| # | Unknown | `ContainerManager` method at stake | What the probe does |
|---|---------|-----------------------------------|---------------------|
| 1 | **Exec semantics** — native exec? streamed or buffered? | `execInContainer`, `execStreaming` | Run a command that emits output slowly; observe whether chunks arrive incrementally or all at once. |
| 2 | **Resource ceiling** — does the `L` tier (2 cores / 4 GB / 40 GB) fit our build/test workloads? | (spawn `memoryBytes`, CPU) | Run `nproc`, `free -m`, `df -h` inside the sandbox and print them. |
| 3 | **File I/O + directory extraction** | `writeFile`, `readFile`, `extractDirectoryFromContainer` | Write a file, read it back, then tar a directory and pull it out. ACI **can't** do extraction — can Sandboxes? |
| 4 | **Egress policy: runtime-mutable?** | `refreshFirewall`, `networkPolicyMode` | Start default-`Deny`; curl an allowed host (expect OK) and a denied host (expect blocked); then **mutate the policy at runtime** and re-curl the previously-denied host. |

It also times **provision** (unknown 0 — sub-second claim) and **suspend/resume**
(maps to `stop()`/`start()`).

## ⚠️ Read before running — preview API uncertainty

The exact SDK class/method names below are taken from Microsoft blog posts and search
results, **not** from a doc page I could load (the API reference and
`sandboxes.azure.com/docs` return 403 without an Entra login). Treat
`sandbox_client.py` as a **thin adapter you finalize against the real quickstart**
at <https://sandboxes.azure.com> (which you can open; I can't).

Everything that's likely to drift is isolated in `sandbox_client.py` and marked
`# VERIFY:`. The probe logic in `probe.py` is written against that adapter so you
only fix things in one place.

## Prerequisites

1. **Azure CLI logged in**, or a service principal — uses `DefaultAzureCredential`.
   ```bash
   az login
   ```
2. **Preview enrollment + feature flags.** Sandboxes is public preview; VNet and
   managed identity are behind feature flags. Personal Microsoft accounts are
   **not** supported — must be an Entra (org) identity.
3. **Role assignment.** The dynamic-sessions equivalent needs the
   *"Azure ContainerApps Session Executor"* role on the resource. Confirm the
   sandbox equivalent in the quickstart and grant it to your identity.
4. **An OCI image** to boot. Default below is a stock image; swap in one of our
   base images (e.g. an ACR `autopod-node22`) once basic exec works.
5. Python 3.10+.

```bash
cd spikes/aca-sandbox
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## Configure

All config is env vars (see top of `probe.py`):

```bash
export AZURE_SUBSCRIPTION_ID=...
export AZURE_RESOURCE_GROUP=autopod-spike-rg
export AZURE_LOCATION=westeurope          # confirm Sandboxes is available in-region
export SANDBOX_IMAGE=mcr.microsoft.com/cbl-mariner/base/core:2.0   # or an ACR base image
export SANDBOX_TIER=L                       # XS | S | M | L  — L = 2 cores / 4 GB / 40 GB
export SANDBOX_ALLOWED_HOST=api.github.com  # host the egress test will allow
export SANDBOX_DENIED_HOST=example.com      # host the egress test expects to be blocked
```

## Run

```bash
python probe.py
```

Each probe prints `PASS`, `FAIL`, or `UNKNOWN (verify SDK surface)` with timings.
A full run finishes by **destroying the sandbox** — but check the Sandboxes portal
afterward to be sure nothing is left billing.

## Reading the results

The output maps 1:1 onto the decision:

- **Unknown 1 buffered, not streamed** → our backend needs the ACI-style log-poll +
  `EXIT_CODE=N` fallback for `execStreaming`. Annoying but already-solved pattern.
- **Unknown 2 — L tier too small** → biggest blocker. If `dotnet`/`node` builds OOM
  at 4 GB, Sandboxes is out for heavy profiles until larger tiers ship.
- **Unknown 3 extraction unsupported** → mirror ACI (`extractDirectoryFromContainer`
  throws) or route through a Blob volume.
- **Unknown 4 runtime mutation works** → the headline win; `restricted` mode +
  `refreshFirewall()` are feasible without the HAProxy/iptables machinery.

Drop the findings into the ADR we deferred.
