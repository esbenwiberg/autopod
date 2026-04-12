A new Placement type is exported from packages/shared with kinds local-docker, aci, and runner
Profile and Session tables both carry a nullable placement column
When a session placement is set, it takes precedence over the legacy executionTarget field
When placement is unset, the system falls back to executionTarget for backwards compatibility
A new runners table tracks id, display name, capabilities JSON, credential fingerprint, credential hash, status, enrolled_at, last_seen_at
A new runner_enrollments table tracks single-use enrollment tokens with expires_at and consumed_at
The daemon exposes POST /api/runners/enrollments to issue an enrollment token
The daemon exposes POST /api/runners/:id/register for a runner to exchange an enrollment token for a long-lived credential
The daemon exposes GET /api/runners/:id/ws as a Fastify WebSocket route authenticating via runner credential in the Authorization header
The daemon exposes DELETE /api/runners/:id to revoke a runner and kills any in-flight sessions on that runner
The runner WebSocket protocol uses JSON text frames and binary frames for tar payloads
Every request-type message carries a correlation id that the response echoes
A hello message carrying protocolVersion is the first message sent by the runner
The daemon rejects runners with an incompatible protocolVersion with a specific error logged
A new @autopod/runner package exists with an autopod-runner CLI exposing register and start subcommands
autopod-runner register accepts --daemon, --token, --id, stores credential locally at ~/.autopod/runner/credential
autopod-runner start connects to the daemon, sends hello, and processes daemon-to-runner messages
The runner spawns containers via its local Docker socket when it receives a spawn message
The runner applies a workspace tar uploaded from the daemon into a local volume bind-mounted into the container
The runner tars the container workspace on exit and streams it back, excluding node_modules, dist, .next, bin, obj, target
The runner hosts an HTTP MCP proxy on loopback at a configurable port
Container environment AUTOPOD_CONTAINER_HOST points at the runner's loopback MCP port, not the daemon
The runner forwards incoming MCP HTTP requests to the daemon over WS and returns the daemon's response to the container
The runner emits heartbeat messages at the interval specified in the daemon's welcome message
A RemoteContainerManager class on the daemon implements the ContainerManager interface by marshalling calls over the WS
The container factory in packages/daemon/src/index.ts routes placement kind runner to a RemoteContainerManager bound to that runner id
A new runner_offline status is added to SessionStatus with transitions running to runner_offline, runner_offline to running, runner_offline to failed, runner_offline to killing
When a runner's WS drops during an active session, the daemon transitions the session to runner_offline
When the runner reconnects, the daemon queries get_status for the session's container and either resumes or fails the session
A session targeting an offline runner remains queued indefinitely and logs that the target is offline
A session targeting an offline runner starts automatically when the runner comes online without user intervention
When the runner cannot reach the daemon for longer than 60 seconds it stops its local containers and marks sessions failed
The desktop app shows a Runners pane listing registered runners with status, last_seen_at, capabilities
The desktop app supports issuing an enrollment token via a new runner UI affordance
The desktop app shows runner online and offline state transitions within one heartbeat interval
A daemon Docker image is published that runs on both amd64 and arm64
A deployment guide documents running the daemon on an Azure Standard_B1s VM with a managed disk
A deployment guide documents running the daemon on a Raspberry Pi as a systemd service
A deployment guide documents installing the runner on macOS via launchd and on Linux via systemd
MCP proxy median tool-call latency is under 50ms in a Pi-over-Tailscale configuration with a noop test tool
A 300MB worktree tar upload completes in under 45 seconds on a 50Mbps link
Reconnect after a 15-minute offline window completes within 5 seconds once network is restored
Existing placement aci continues to route sessions through the existing AciContainerManager unchanged
Existing placement local-docker continues to route sessions through the existing DockerContainerManager unchanged
Existing session lifecycle tests pass without modification when placement is unset
