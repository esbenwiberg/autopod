"""Thin adapter over the (preview, early-access) Azure Container Apps Sandboxes SDK.

EVERYTHING IN THIS FILE THAT IS LIKELY TO DRIFT IS MARKED `# VERIFY:`.

The exact package/class/method names are taken from Microsoft blog posts and search
results, not a doc page that could be loaded (the API reference + sandboxes.azure.com
return 403 without an Entra login). Open the quickstart at https://sandboxes.azure.com,
reconcile the calls below, and the probe in `probe.py` should run unchanged.

Design intent: every SDK touchpoint is wrapped so that a renamed/missing method fails
with an actionable "VERIFY: ..." message instead of a cryptic AttributeError. That way a
spike run tells you *which* assumption was wrong, not just that something broke.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Iterator


@dataclass
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int
    wall_ms: int
    # For the streaming probe: timestamps (ms since exec start) at which each output
    # chunk arrived. Length > 1 with spread-out values ⇒ genuine streaming.
    chunk_arrival_ms: list[int] = field(default_factory=list)


@dataclass
class SandboxHandle:
    id: str
    raw: object  # the underlying SDK session/sandbox object
    provision_ms: int


class SandboxClient:
    """Wraps the preview SDK. Construct, then use create/exec/file/egress/lifecycle."""

    def __init__(
        self,
        *,
        subscription_id: str,
        resource_group: str,
        location: str,
    ) -> None:
        self.subscription_id = subscription_id
        self.resource_group = resource_group
        self.location = location
        self._client = self._build_client()

    # ----- construction -----------------------------------------------------

    def _build_client(self):
        try:
            from azure.identity import DefaultAzureCredential
        except ImportError as e:  # pragma: no cover - prereq guidance
            raise RuntimeError(
                "Missing azure-identity. `pip install -r requirements.txt`."
            ) from e

        try:
            # VERIFY: package + client class name. Search indicates the package is
            # `azure-containerapps-sandbox`; the client class name is unconfirmed.
            from azure.containerapps.sandbox import SandboxClient as _SdkClient  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "Could not import the Sandboxes SDK.\n"
                "  Expected: `pip install azure-containerapps-sandbox`\n"
                "  VERIFY the import path against https://sandboxes.azure.com quickstart.\n"
                "  If the SDK is not yet published for your tenant, fall back to the raw\n"
                "  data-plane REST API (see README) — the dynamic-sessions execute call\n"
                "  is the closest documented analogue."
            ) from e

        cred = DefaultAzureCredential()
        # VERIFY: constructor signature.
        return _SdkClient(
            credential=cred,
            subscription_id=self.subscription_id,
            resource_group=self.resource_group,
        )

    # ----- unknown 0: provision ---------------------------------------------

    def create_sandbox(self, *, image: str, tier: str, egress_policy: dict) -> SandboxHandle:
        """Provision a sandbox from an OCI image with an initial egress policy.

        Returns a handle and the wall-clock provision time (the 'sub-second' claim).
        """
        t0 = time.monotonic()
        # VERIFY: method name + kwargs. Blog posts reference `create_session(agent_id,
        # policy=, config=)`; the raw SDK may instead expose `create_sandbox` on a
        # SandboxGroups operations object. The resource type is Microsoft.App/SandboxGroups.
        raw = self._call(
            self._client,
            ["create_sandbox", "create_session", "begin_create"],
            location=self.location,
            image=image,
            resource_tier=tier,  # VERIFY: 'XS'|'S'|'M'|'L' vs an explicit cpu/memory object
            egress_policy=egress_policy,
        )
        provision_ms = int((time.monotonic() - t0) * 1000)
        sandbox_id = getattr(raw, "id", None) or getattr(raw, "session_id", "unknown")
        return SandboxHandle(id=str(sandbox_id), raw=raw, provision_ms=provision_ms)

    # ----- unknown 1: exec (buffered vs streamed) ---------------------------

    def exec(self, handle: SandboxHandle, command: str, *, stream: bool = False) -> ExecResult:
        """Run a shell command. With stream=True, records chunk arrival times so the
        probe can tell genuine streaming from a single buffered flush."""
        t0 = time.monotonic()
        arrivals: list[int] = []
        out_parts: list[str] = []
        err_parts: list[str] = []
        exit_code = -1

        if stream:
            # VERIFY: streaming method + chunk shape. If the SDK has no streaming exec,
            # this will fall through to the buffered path and the probe will (correctly)
            # report "no native streaming".
            stream_iter = self._maybe_call(
                handle.raw,
                ["exec_stream", "execute_stream", "stream_command"],
                command=command,
            )
            if stream_iter is not None:
                for chunk in self._iter(stream_iter):
                    arrivals.append(int((time.monotonic() - t0) * 1000))
                    out_parts.append(getattr(chunk, "stdout", "") or "")
                    err_parts.append(getattr(chunk, "stderr", "") or "")
                    if getattr(chunk, "exit_code", None) is not None:
                        exit_code = chunk.exit_code
                return ExecResult(
                    "".join(out_parts), "".join(err_parts), exit_code,
                    int((time.monotonic() - t0) * 1000), arrivals,
                )

        # Buffered path. VERIFY: `execute_code(code=, context=)` per blog posts, or an
        # `exec`/`execute_command` returning stdout/stderr/exit_code.
        res = self._call(
            handle.raw,
            ["exec", "execute_command", "execute_code"],
            command=command,
            code=command,  # tolerated-extra kwarg; harmless if ignored
        )
        wall = int((time.monotonic() - t0) * 1000)
        return ExecResult(
            stdout=str(getattr(res, "stdout", getattr(res, "output", "")) or ""),
            stderr=str(getattr(res, "stderr", "") or ""),
            exit_code=int(getattr(res, "exit_code", getattr(res, "exitCode", 0)) or 0),
            wall_ms=wall,
            chunk_arrival_ms=[wall],
        )

    # ----- unknown 3: file I/O ----------------------------------------------

    def write_file(self, handle: SandboxHandle, path: str, content: bytes) -> None:
        # VERIFY: upload method name + arg names (bytes vs base64 vs stream).
        self._call(handle.raw, ["upload_file", "write_file", "put_file"], path=path, content=content)

    def read_file(self, handle: SandboxHandle, path: str) -> bytes:
        res = self._call(handle.raw, ["download_file", "read_file", "get_file"], path=path)
        if isinstance(res, (bytes, bytearray)):
            return bytes(res)
        return bytes(getattr(res, "content", b"") or b"")

    def extract_dir(self, handle: SandboxHandle, container_dir: str, host_path: str) -> bool:
        """Try to pull a whole directory out. ACI cannot do this. Returns True on success.
        Strategy: tar the dir in-sandbox, download the tarball. If neither a native
        archive API nor download works, returns False (⇒ mirror ACI's limitation)."""
        tar_path = "/tmp/_spike_extract.tar.gz"
        self.exec(handle, f"tar czf {tar_path} -C {container_dir} .")
        try:
            blob = self.read_file(handle, tar_path)
        except Exception:
            return False
        if not blob:
            return False
        with open(host_path, "wb") as f:
            f.write(blob)
        return True

    # ----- unknown 4: runtime-mutable egress --------------------------------

    def update_egress(self, handle: SandboxHandle, egress_policy: dict) -> None:
        # VERIFY: the runtime-update method. Docs say the policy is mutable at runtime and
        # "subsequent requests are evaluated against the updated policy" — but the method
        # name was not in any loadable doc.
        self._call(
            handle.raw,
            ["update_egress_policy", "set_egress_policy", "update_network_policy"],
            egress_policy=egress_policy,
        )

    # ----- maps to stop()/start() -------------------------------------------

    def suspend(self, handle: SandboxHandle, *, mode: str = "memory") -> int:
        t0 = time.monotonic()
        self._call(handle.raw, ["suspend", "begin_suspend"], mode=mode)  # 'memory' | 'disk'
        return int((time.monotonic() - t0) * 1000)

    def resume(self, handle: SandboxHandle) -> int:
        t0 = time.monotonic()
        self._call(handle.raw, ["resume", "begin_resume"])
        return int((time.monotonic() - t0) * 1000)

    def destroy(self, handle: SandboxHandle) -> None:
        self._call(handle.raw, ["delete", "destroy", "destroy_session", "begin_delete"])

    # ----- internals: forgiving SDK dispatch --------------------------------

    def _call(self, obj, names: list[str], **kwargs):
        """Call the first method in `names` that exists on `obj`, passing only the kwargs
        its signature accepts. Raises a VERIFY message listing what was tried."""
        import inspect

        for name in names:
            fn = getattr(obj, name, None)
            if fn is None or not callable(fn):
                continue
            try:
                sig = inspect.signature(fn)
                accepted = {k: v for k, v in kwargs.items() if k in sig.parameters}
            except (TypeError, ValueError):
                accepted = kwargs
            result = fn(**accepted)
            # Tolerate long-running-operation pollers (begin_* style).
            if hasattr(result, "result") and callable(result.result):
                return result.result()
            return result
        raise RuntimeError(
            f"VERIFY: none of {names} found on {type(obj).__name__}. "
            "Reconcile method names against the sandboxes.azure.com quickstart."
        )

    def _maybe_call(self, obj, names: list[str], **kwargs):
        try:
            return self._call(obj, names, **kwargs)
        except RuntimeError:
            return None

    @staticmethod
    def _iter(maybe_iter) -> Iterator:
        if hasattr(maybe_iter, "__iter__"):
            return iter(maybe_iter)
        return iter([maybe_iter])


# ----- egress policy helpers (shape per the egress-policies doc) -------------
# default_action: "Allow" | "Deny"; rules matched in order on (host, path, method).
# VERIFY the exact JSON keys against the quickstart.

def allow_all_policy() -> dict:
    return {"default_action": "Allow", "rules": []}


def deny_all_policy() -> dict:
    return {"default_action": "Deny", "rules": []}


def restricted_policy(allowed_hosts: list[str]) -> dict:
    return {
        "default_action": "Deny",
        "rules": [{"match": {"host": h}, "action": "Allow"} for h in allowed_hosts],
    }


def env(name: str, default: str | None = None, *, required: bool = False) -> str:
    val = os.environ.get(name, default)
    if required and not val:
        raise SystemExit(f"Missing required env var: {name}")
    return val or ""
