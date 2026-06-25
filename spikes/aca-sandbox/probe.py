#!/usr/bin/env python3
"""Feasibility probe for Azure Container Apps Sandboxes as an autopod execution backend.

Standalone — does NOT import or touch the daemon. Answers the four unknowns from the
README by provisioning one sandbox and running shell inside it. See sandbox_client.py
for the (preview, VERIFY-marked) SDK adapter.

Run:  python probe.py    (after `az login` + `pip install -r requirements.txt`)
"""

from __future__ import annotations

import sys
import traceback

from sandbox_client import (
    SandboxClient,
    allow_all_policy,
    deny_all_policy,
    env,
    restricted_policy,
)

# --- config (env-driven; see README) ----------------------------------------
SUBSCRIPTION = env("AZURE_SUBSCRIPTION_ID", required=True)
RESOURCE_GROUP = env("AZURE_RESOURCE_GROUP", "autopod-spike-rg")
LOCATION = env("AZURE_LOCATION", "westeurope")
SANDBOX_GROUP = env("SANDBOX_GROUP", "autopod-spike")
IMAGE = env("SANDBOX_IMAGE", "mcr.microsoft.com/cbl-mariner/base/core:2.0")
TIER = env("SANDBOX_TIER", "L")  # XS|S|M|L — L = 2 cores / 4 GB / 40 GB
ALLOWED_HOST = env("SANDBOX_ALLOWED_HOST", "api.github.com")
DENIED_HOST = env("SANDBOX_DENIED_HOST", "example.com")

# --- tiny result tracker -----------------------------------------------------
RESULTS: list[tuple[str, str, str]] = []  # (probe, verdict, detail)


def record(probe: str, verdict: str, detail: str = "") -> None:
    RESULTS.append((probe, verdict, detail))
    print(f"  → {verdict}: {detail}" if detail else f"  → {verdict}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


# --- probes ------------------------------------------------------------------

def probe_provision(client: SandboxClient):
    section("Unknown 0 — provision time (sub-second claim) + default-DENY egress")
    handle = client.create_sandbox(image=IMAGE, tier=TIER, egress_policy=deny_all_policy())
    verdict = "PASS" if handle.provision_ms < 3000 else "SLOW"
    record("provision", verdict, f"{handle.provision_ms} ms, id={handle.id}")
    return handle


def probe_exec_streaming(client, handle) -> None:
    section("Unknown 1 — exec: native? buffered vs streamed?")
    # Emit 3 lines ~700ms apart. Genuine streaming ⇒ chunks arrive spread out.
    cmd = "for i in 1 2 3; do echo line$i; sleep 0.7; done"
    res = client.exec(handle, cmd, stream=True)
    got_output = "line3" in res.stdout
    spread = (max(res.chunk_arrival_ms) - min(res.chunk_arrival_ms)) if res.chunk_arrival_ms else 0
    if not got_output:
        record("exec", "FAIL", f"no expected output; exit={res.exit_code} stderr={res.stderr[:120]}")
    elif len(res.chunk_arrival_ms) > 1 and spread > 500:
        record("exec-streaming", "PASS",
               f"{len(res.chunk_arrival_ms)} chunks over {spread} ms — genuine streaming")
    else:
        record("exec-streaming", "BUFFERED",
               f"output arrived in one flush at {res.wall_ms} ms — needs ACI-style "
               "log-poll fallback for execStreaming")


def probe_resources(client, handle) -> None:
    section(f"Unknown 2 — resource ceiling (tier {TIER}); do our builds fit?")
    res = client.exec(handle, "nproc; echo '---'; free -m 2>/dev/null | head -2; "
                              "echo '---'; df -h / 2>/dev/null | tail -1")
    print(res.stdout.rstrip() or "(no output)")
    record("resources", "INFO", "compare against heaviest profile (dotnet/node build+test)")


def probe_file_io(client, handle) -> None:
    section("Unknown 3 — file write/read + directory extraction (ACI can't extract)")
    payload = b"autopod-spike\n" + bytes(range(256))  # text + binary
    try:
        client.write_file(handle, "/tmp/spike/probe.bin", payload)
        back = client.read_file(handle, "/tmp/spike/probe.bin")
        record("file-io", "PASS" if back == payload else "MISMATCH",
               f"wrote {len(payload)}B, read {len(back)}B, equal={back == payload}")
    except Exception as e:  # noqa: BLE001
        record("file-io", "FAIL", f"{type(e).__name__}: {e}")

    section("Unknown 3b — extractDirectoryFromContainer equivalent")
    try:
        ok = client.extract_dir(handle, "/tmp/spike", "/tmp/spike_pulled.tar.gz")
        record("dir-extract", "PASS" if ok else "UNSUPPORTED",
               "tarball pulled to host" if ok else "mirror ACI (throw) or use Blob volume")
    except Exception as e:  # noqa: BLE001
        record("dir-extract", "FAIL", f"{type(e).__name__}: {e}")


def probe_egress_mutation(client, handle) -> None:
    section("Unknown 4 — egress: default-DENY blocks, runtime mutation unblocks")
    curl = "curl -sS -o /dev/null -w '%{{http_code}}' --max-time 8 https://{host}/ 2>&1 || echo BLOCKED"

    denied_before = client.exec(handle, curl.format(host=DENIED_HOST)).stdout.strip()
    default_deny_blocked = (
        "BLOCKED" in denied_before
        or denied_before in {"000", "403"}
    )
    record("egress-default-deny", "PASS" if default_deny_blocked else "LEAK",
           f"{DENIED_HOST} → {denied_before!r} (want blocked under default Deny)")

    # Mutate at runtime to allow the previously-denied host.
    try:
        client.update_egress(handle, restricted_policy([ALLOWED_HOST, DENIED_HOST]))
        denied_after = client.exec(handle, curl.format(host=DENIED_HOST)).stdout.strip()
        opened = denied_after.startswith(("2", "3", "4"))  # any HTTP response ⇒ egress reached host
        record("egress-runtime-mutate", "PASS" if opened else "NO-EFFECT",
               f"{DENIED_HOST} after policy update → {denied_after!r} "
               "(PASS ⇒ refreshFirewall() is feasible natively)")
    except Exception as e:  # noqa: BLE001
        record("egress-runtime-mutate", "FAIL", f"{type(e).__name__}: {e}")


def probe_suspend_resume(client, handle) -> None:
    section("Bonus — suspend/resume (maps to stop()/start())")
    try:
        s = client.suspend(handle, mode="memory")
        r = client.resume(handle)
        # Confirm in-memory state survived: write a marker, suspend/resume already done,
        # so just confirm the sandbox is alive and responsive post-resume.
        alive = client.exec(handle, "echo alive").stdout.strip()
        record("suspend-resume", "PASS" if "alive" in alive else "DEGRADED",
               f"suspend {s} ms / resume {r} ms, post-resume exec={alive!r}")
    except Exception as e:  # noqa: BLE001
        record("suspend-resume", "FAIL", f"{type(e).__name__}: {e}")


# --- main --------------------------------------------------------------------

def main() -> int:
    print("Azure Container Apps Sandboxes — autopod backend feasibility probe")
    print(
        f"sub={SUBSCRIPTION[:8]}… rg={RESOURCE_GROUP} group={SANDBOX_GROUP} "
        f"loc={LOCATION} image={IMAGE} tier={TIER}"
    )

    client = SandboxClient(
        subscription_id=SUBSCRIPTION,
        resource_group=RESOURCE_GROUP,
        location=LOCATION,
        sandbox_group=SANDBOX_GROUP,
    )

    handle = None
    try:
        handle = probe_provision(client)
        probe_exec_streaming(client, handle)
        probe_resources(client, handle)
        probe_file_io(client, handle)
        probe_egress_mutation(client, handle)
        probe_suspend_resume(client, handle)
    except Exception:  # noqa: BLE001
        print("\n!!! probe aborted:")
        traceback.print_exc()
    finally:
        if handle is not None:
            section("Teardown — destroying sandbox")
            try:
                client.destroy(handle)
                print("  → destroyed (verify in the Sandboxes portal nothing is left billing)")
            except Exception as e:  # noqa: BLE001
                print(f"  → DESTROY FAILED ({e}); delete manually to stop billing!")

    section("SUMMARY")
    for probe, verdict, detail in RESULTS:
        print(f"  {probe:<24} {verdict:<12} {detail}")
    print("\nNext: fold these verdicts into the deferred ADR-005 (Sandboxes vs ACI vs Docker).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
