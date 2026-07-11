# @autopod/pi-worker

Trusted Pi worker extension package for Autopod-managed pods.

Runtime-facing contract:

- Load `AUTOPOD_PI_WORKER_ENTRYPOINT` from the pinned `AUTOPOD_PI_WORKER_PACKAGE`.
- Pass `PiWorkerConfig.mcpServers` from the pod `SpawnConfig` without reading repository MCP or Pi extension files.
- Set `requiredServerName` to the Autopod control-plane MCP server name, currently `escalation`.
- Honor `AUTOPOD_PI_MANAGED_STARTUP`: project extensions and executable project resources must remain disabled.

The package is intentionally transport-only. It adapts configured HTTP and stdio MCP servers into native Pi tools while leaving approvals, actions, validation, memory, sanitization, and audit behind the existing MCP control plane.
