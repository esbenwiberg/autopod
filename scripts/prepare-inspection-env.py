#!/usr/bin/env python3
"""Prepare (never install) the two JSON bindings from a checked operator packet."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

BINDINGS = (
    ("AUTOPOD_OPERATOR_PROFILE_SET", "profiles.json"),
    ("AUTOPOD_OPERATOR_ENROLLMENT", "enrollment.json"),
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def render(packet):
    lines, expected = [], []
    for name, filename in BINDINGS:
        with (packet / filename).open("rb") as f:
            raw = f.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise ValueError("binding too large")
        obj = json.loads(raw.decode("utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("binding must be a JSON object")
        # Single quotes in systemd single-quoted values have no escape syntax.
        # Escape those characters *as JSON*, including in object keys. ASCII
        # serialization also keeps embedded newlines off the assignment boundary.
        value = json.dumps(obj, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
        value = value.replace("'", r"\u0027")
        lines.append(f"{name}='{value}'\n")
        expected.append(digest(value.encode("ascii")))
    return "".join(lines).encode("ascii"), expected


def verify(path, expected):
    # PID 1 reads the candidate. The transient process only compares bytes;
    # no daemon config, provider, DB, service credentials or packet executable.
    checker = """import hashlib, os, sys
names = (b'AUTOPOD_OPERATOR_PROFILE_SET', b'AUTOPOD_OPERATOR_ENROLLMENT')
if any(k not in os.environb for k in names) or [hashlib.sha256(os.environb[k]).hexdigest() for k in names] != sys.argv[1:]:
    print('BINDINGS_MISMATCH')
    sys.exit(42)
print('BINDINGS_OK')
"""
    proc = subprocess.run([
        "/usr/bin/systemd-run", "--system", "--quiet", "--wait", "--pipe", "--collect",
        "-p", "DynamicUser=yes", "-p", "PrivateNetwork=yes", "-p", "NoNewPrivileges=yes",
        "-p", "RuntimeMaxSec=15", "-p", f"EnvironmentFile={path}",
        "/usr/bin/python3", "-I", "-S", "-c", checker, *expected,
    ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
    if proc.returncode == 42 and proc.stdout.strip() == b"BINDINGS_MISMATCH":
        raise ValueError("systemd binding mismatch")
    if proc.returncode or proc.stdout.strip() != b"BINDINGS_OK":
        raise RuntimeError("systemd probe unavailable")


def prepare(packet, output):
    data, expected = render(packet)
    # /run is a trusted, specifier-free path on the system manager's host.
    # Leave only a successfully tested inode for the separate activation gate.
    directory = Path(tempfile.mkdtemp(prefix="autopod-inspection-", dir="/run"))
    path = directory / "inspection.env"
    try:
        with path.open("xb") as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(data)
        verify(path, expected)
        print(json.dumps({"path": str(path), "sha256": digest(data)}), file=output, flush=True)
    except BaseException:
        path.unlink(missing_ok=True)
        directory.rmdir()
        raise


if __name__ == "__main__":
    if len(sys.argv) != 2 or os.geteuid() != 0:
        sys.exit("usage (as root on systemd host): prepare-inspection-env.py CHECKED_PACKET")
    try:
        prepare(Path(sys.argv[1]), sys.stdout)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        sys.exit("inspection environment preflight failed; do not install or restart")
