# Security boundaries

[README](../README.md#security-boundaries) · [Network configuration](reference/profiles.md#network-policy) · [Action configuration](reference/profiles.md#action-control-plane)

Autopod treats agent requests and external content as untrusted. Its controls
cover different boundaries: where a worker can connect, which daemon tools it
can invoke, what brokered content returns, and what evidence an operator can
inspect. None of these makes prompt injection impossible.

## Worker egress

Choose a network policy for the workload; don't assume a container means an
air gap. Check the effective launch policy, not just the last profile you edited.

| Mode | Meaning |
| --- | --- |
| `allow-all` | No outbound restriction from this policy. |
| `deny-all` | Exception-only egress, not literal zero network traffic. |
| `restricted` | A hostname allowlist with target-specific enforcement and exceptions. |

For **Docker**, an **enabled effective network policy** creates the per-pod
bridge; its companion sidecars share that bridge. Without effective network
configuration, the Docker manager does not select a per-pod network, so don't
assume this network separation exists merely because a worker is containerized.
Restricted HTTPS is redirected by iptables through an HAProxy
TLS-SNI allowlist, without decrypting TLS. Outbound port 80 is dropped, other
unapproved traffic is rejected, and IPv6 outbound traffic is rejected apart from
loopback and established/related connections. This is not TLS-content inspection.

The Docker rules retain explicit paths for the daemon gateway, declared sidecar
IPs, Docker's DNS resolver, loopback, and established/related connections. DNS
forwarding is not a hostname-content firewall. Those exceptions matter even in
`deny-all`; don't describe that mode as air-gapped.

The restricted allowlist normally includes built-in provider/registry hosts.
`replaceDefaults: true` removes that built-in set, but is not a switch to remove
all control-plane exceptions. Profile entries, configured MCP/registry hosts,
and launch-specific control-plane hosts can also contribute to the resolved list.

Docker firewall setup failures abort restricted/deny-all provisioning by default.
The development escape hatch `AUTOPOD_FAIL_OPEN_FIREWALL=1` deliberately permits
continuing without that isolation; don't enable it when you rely on enforcement.

**Azure Container Apps Sandboxes** uses the platform's native per-sandbox egress
policy, not Docker's iptables/HAProxy implementation. Check the
[sandbox guide](azure-container-apps-sandboxes.md) for that target's requirements
and limitations. Don't infer identical DNS, sidecar, or transport behavior.

## Brokered tools, not ambient authority

The action control plane brokers configured GitHub, Azure DevOps, Azure, and
HTTP operations through daemon handlers. It checks enabled action groups,
request parameters, configured resource allowlists, and applicable approval
requirements before dispatch. Limits and approvals must be configured for the
actions you expose; an allowed tool is still a capability to use carefully.

The generic HTTP action handler validates destinations and uses a DNS-pinned
transport to reduce SSRF and rebinding risk. This protection is for that handler,
not a claim about arbitrary worker shell commands or every external MCP server.

Remote injected MCP servers can be reached through a pod-authenticated daemon
proxy. The proxy resolves the selected server and adds its authentication
headers server-side, rather than embedding those headers in the worker's
proxied server configuration. Local stdio tools are a different execution path.

## Prompt-injection and data hygiene

Configured action responses can pass through:

- **Field selection:** supported action handlers return the configured response
  fields instead of blindly forwarding the full API object.
- **Injection quarantine:** pattern-based scoring can mark content as untrusted,
  wrap it with warnings, or omit it according to thresholds and block policy.
- **PII/secret-pattern redaction:** configured sanitization handles recognized
  patterns and explicitly selected redact fields.

The action engine uses the shared content processor with the selected policy.
The remote MCP proxy has an optional `contentProcessing` hook, but the normal
daemon server registration does **not** supply it. Consequently, default remote
MCP proxy responses do not receive that injection/PII filtering or its associated
filter-finding recording. Don't count the optional hook as an active protection.
Upstream MCP tools might have their own controls, but those are not this filter.

Action filtering is configurable; it is not an inspection layer over every file
an agent reads or every byte it can download. The quarantine scanner is heuristic,
not a semantic proof that content is safe. An attacker may still influence an
agent through an allowed response or repository.

## Repository and validation checkpoints

Repository scans provide another inspection surface: secretlint-based secret
checking, plus optional ML-backed PII and prompt-injection detectors. ML models
must be available and the corresponding detector enabled in policy; these are
not automatically active for every task. Scan policy controls provisioning/push
checkpoints, file scope, thresholds, and warn/block/escalate outcomes. Workspace
push handling can escalate a blocking finding for an operator decision.

These file scans are separate from brokered-response quarantine. Configured
validation can also run lint, SAST, build, test, and contract-proof commands.
Findings and incomplete scans feed review evidence; neither a clean scan nor a
successful SAST command proves that code or dependencies are vulnerability-free.

## Credentials and identity

Stored profile credentials use AES-256-GCM with a filesystem-protected key. The
key and database still need a trusted host, access controls, backup, and rotation.
A host compromise that exposes both is not solved by encryption at rest.

Brokered action authentication is resolved by the daemon. That does **not** mean
no credential ever enters a worker: model-provider runtimes, private registries,
and explicitly configured tool workflows may need selected credentials. Treat
those as exposed to the code running in that worker and scope their privileges.

Worker MCP calls use expiring, pod-scoped HMAC tokens; the daemon checks the pod
identity instead of trusting a pod ID in the URL. Production client access uses
Entra authentication. Local development-token access is an explicit opt-in, not
an internet-facing deployment recipe; see [setup](getting-started.md).

## Auditability and review

Action audit records are hash-chained and verifiable. Egress denials and detected
injection/PII findings have dedicated evidence surfaces, and Readiness Review
combines those signals with validation, security, scope, and delivery state.
This is evidence for investigation and policy decisions—not a tamper-proof host
or a complete packet/file/tool-call transcript. Don't assume every denied
pre-dispatch request appears as an executed-action audit record.

A security signal is not automatically the same as a blocking validation result.
[Readiness and approval policy](reference/validation.md#validation-pipeline)
determine how evidence affects the decision to proceed.

## Operational limits

- An allowlisted service, model endpoint, or permitted tool can still move data.
  Egress policy cannot determine the intent of every allowed request.
- Containers and sidecars do not eliminate kernel, runtime, dependency, or host
  compromise. Give sidecars and injected tools only the access they need.
- Keep the daemon within a trusted operator boundary; authentication is not a
  claim of hostile multi-tenant isolation or fine-grained per-resource ACLs.
- Review code and evidence before shipping. Automation remains subject to the
  configured checks, readiness, approval, and external delivery gates.

## Implementation references

This overview was checked against the application source at `0c78989d`; it is a
code/documentation review, not a penetration-test report or live enforcement test.

| Boundary | Source |
| --- | --- |
| Docker egress and allowlist resolution | [Network manager](../packages/daemon/src/containers/docker-network-manager.ts), [provisioning gate](../packages/daemon/src/pods/provisioning-container.ts), [firewall startup handling](../packages/daemon/src/containers/docker-container-manager.ts) |
| Sandbox egress | [Sandbox manager](../packages/daemon/src/containers/sandbox-container-manager.ts) |
| Action permissions and response processing | [Action engine](../packages/daemon/src/actions/action-engine.ts), [field selection](../packages/daemon/src/actions/handlers/handler.ts) |
| Generic HTTP destination handling | [HTTP handler](../packages/daemon/src/actions/generic-http-handler.ts), [pinned transport](../packages/daemon/src/actions/pinned-http-transport.ts) |
| Remote MCP proxy and actual wiring | [Proxy handler](../packages/daemon/src/api/mcp-proxy-handler.ts), [server registration](../packages/daemon/src/api/server.ts) |
| Content filters | [Processor](../packages/shared/src/sanitize/processor.ts), [quarantine](../packages/shared/src/sanitize/quarantine.ts) |
| Repository scans and outcomes | [Scanner](../packages/daemon/src/security/repo-scanner.ts), [policy](../packages/daemon/src/security/scan-policy.ts), [readiness](../packages/daemon/src/pods/readiness-review.ts) |
| Stored credentials and worker identity | [Credential cipher](../packages/daemon/src/crypto/credentials-cipher.ts), [pod tokens](../packages/daemon/src/crypto/pod-tokens.ts) |
| Action audit integrity | [Audit repository](../packages/daemon/src/actions/audit-repository.ts) |

The older [threat model](threat-model.md) records additional scenarios and
assumptions, but includes historical architecture and implementation claims;
use the current source and this boundary-specific overview rather than copying
its ACI-era details as current behavior.
