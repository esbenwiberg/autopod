import SwiftUI

/// High-level overview of Autopod capabilities — visual feature cards with key highlights.
public struct FeatureOverviewView: View {
    @State private var hoveredFeature: String?
    @Binding public var selectedFeature: FeatureCategory?

    public init(selectedFeature: Binding<FeatureCategory?>) {
        self._selectedFeature = selectedFeature
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                hero
                featureGrid
                lifecycleBanner
                architectureDiagram
            }
            .padding(28)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "server.rack")
                    .font(.system(size: 28))
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Autopod")
                        .font(.title.weight(.bold))
                    Text("Autonomous AI session orchestration platform")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Autopod provisions isolated containers, runs AI coding agents, validates their output, and manages the full lifecycle from task to merged PR — with human oversight at every critical step.")
                .font(.body)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .padding(.top, 4)
        }
    }

    // MARK: - Feature grid

    private var featureGrid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 260), spacing: 14)],
            alignment: .leading,
            spacing: 14
        ) {
            ForEach(FeatureCategory.allCases) { feature in
                featureCard(feature)
            }
        }
    }

    private func featureCard(_ feature: FeatureCategory) -> some View {
        let isHovered = hoveredFeature == feature.id

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: feature.icon)
                    .font(.system(size: 16))
                    .foregroundStyle(feature.color)
                    .frame(width: 28, height: 28)
                    .background(feature.color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                Text(feature.title)
                    .font(.headline)
            }

            Text(feature.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
                .lineLimit(3)

            Divider()

            HStack(spacing: 6) {
                ForEach(feature.highlights, id: \.self) { tag in
                    Text(tag)
                        .font(.system(.caption2).weight(.medium))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(feature.color.opacity(0.08))
                        .foregroundStyle(feature.color)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .shadow(
            color: .black.opacity(isHovered ? 0.08 : 0.02),
            radius: isHovered ? 8 : 3
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    selectedFeature == feature
                        ? feature.color.opacity(0.6)
                        : isHovered ? feature.color.opacity(0.35) : .clear,
                    lineWidth: selectedFeature == feature ? 2 : 1.5
                )
        )
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .onHover { hovering in hoveredFeature = hovering ? feature.id : nil }
        .onTapGesture { selectedFeature = feature }
    }

    // MARK: - Lifecycle banner

    private var lifecycleBanner: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Session Lifecycle")
                .font(.subheadline.weight(.semibold))

            // Flow diagram
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(Array(lifecycleSteps.enumerated()), id: \.offset) { index, step in
                        HStack(spacing: 0) {
                            lifecycleStep(step.icon, step.label, step.color)
                            if index < lifecycleSteps.count - 1 {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9))
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 4)
                            }
                        }
                    }
                }
            }

            Text("Every session follows this pipeline. Failed steps can retry automatically, and human review gates ensure quality before merge.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func lifecycleStep(_ icon: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(color)
                .frame(width: 28, height: 28)
                .background(color.opacity(0.1))
                .clipShape(Circle())
            Text(label)
                .font(.system(.caption2).weight(.medium))
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Architecture diagram

    private var architectureDiagram: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Architecture")
                .font(.subheadline.weight(.semibold))

            HStack(spacing: 16) {
                archComponent("Desktop / CLI", icon: "display", desc: "Monitor & control", color: .blue)
                archArrow
                archComponent("Daemon", icon: "server.rack", desc: "Orchestration & API", color: .purple)
                archArrow
                archComponent("Containers", icon: "shippingbox", desc: "Isolated agents", color: .green)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 16) {
                archComponent("Profiles", icon: "folder", desc: "Config & credentials", color: .orange)
                archArrow
                archComponent("Runtimes", icon: "cpu", desc: "Claude, Codex, Copilot", color: .cyan)
                archArrow
                archComponent("Validation", icon: "checkmark.shield", desc: "Smoke, tests, review", color: .mint)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func archComponent(_ title: String, icon: String, desc: String, color: Color) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(color)
                .frame(width: 32, height: 32)
                .background(color.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 7))
            Text(title)
                .font(.system(.caption).weight(.semibold))
            Text(desc)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var archArrow: some View {
        Image(systemName: "arrow.right")
            .font(.system(size: 10))
            .foregroundStyle(.quaternary)
    }

    // MARK: - Data

    private var lifecycleSteps: [(icon: String, label: String, color: Color)] {
        [
            ("tray.full", "Queued", .gray),
            ("shippingbox", "Provision", .blue),
            ("play.fill", "Running", .blue),
            ("checkmark.shield", "Validate", .cyan),
            ("person.fill.checkmark", "Review", .orange),
            ("arrow.triangle.merge", "Merge", .purple),
            ("checkmark.circle.fill", "Complete", .green),
        ]
    }
}

// MARK: - Feature categories

public enum FeatureCategory: String, CaseIterable, Identifiable {
    case sessionOrchestration
    case containerSecurity
    case multiRuntime
    case actionControlPlane
    case escalationSystem
    case validationPipeline
    case profileManagement
    case realTimeMonitoring

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .sessionOrchestration: "Session Orchestration"
        case .containerSecurity:    "Container Security"
        case .multiRuntime:         "Multi-Runtime Agents"
        case .actionControlPlane:   "Action Control Plane"
        case .escalationSystem:     "Escalation System"
        case .validationPipeline:   "Validation Pipeline"
        case .profileManagement:    "Profile Management"
        case .realTimeMonitoring:   "Real-time Monitoring"
        }
    }

    public var icon: String {
        switch self {
        case .sessionOrchestration: "arrow.triangle.2.circlepath"
        case .containerSecurity:    "lock.shield"
        case .multiRuntime:         "cpu"
        case .actionControlPlane:   "slider.horizontal.3"
        case .escalationSystem:     "bubble.left.and.exclamationmark.bubble.right"
        case .validationPipeline:   "checkmark.shield"
        case .profileManagement:    "folder.badge.gearshape"
        case .realTimeMonitoring:   "waveform.path.ecg"
        }
    }

    public var color: Color {
        switch self {
        case .sessionOrchestration: .blue
        case .containerSecurity:    .red
        case .multiRuntime:         .cyan
        case .actionControlPlane:   .purple
        case .escalationSystem:     .orange
        case .validationPipeline:   .green
        case .profileManagement:    .indigo
        case .realTimeMonitoring:   .teal
        }
    }

    public var summary: String {
        switch self {
        case .sessionOrchestration:
            "Full lifecycle management from task queuing through provisioning, agent execution, validation, human review, and merge. Automatic retries and state machine enforcement."
        case .containerSecurity:
            "Every session runs in an isolated Docker container with per-container iptables firewall rules. Network policies support allow-all, deny-all, or granular host/port allowlists."
        case .multiRuntime:
            "Pluggable runtime architecture supporting Anthropic Claude, OpenAI Codex, and GitHub Copilot. Each runtime streams structured agent events with dedicated parsers."
        case .actionControlPlane:
            "Agents can execute approved control-plane actions — Azure deployments, ADO pipelines, GitHub operations, and generic HTTP calls — with full audit trail."
        case .escalationSystem:
            "MCP server injected into agent containers enables structured escalation: ask a human, consult another AI, report blockers, submit plans, and report progress."
        case .validationPipeline:
            "Automated validation via Playwright smoke tests, unit test execution, and AI-powered code review. Results gate the merge pipeline with configurable thresholds."
        case .profileManagement:
            "Profiles define stack templates, credentials, network policies, private registries, skill injection, and MCP server configuration. Profile inheritance for shared defaults."
        case .realTimeMonitoring:
            "WebSocket event streaming delivers agent activity, status transitions, and escalation events to the desktop app, CLI TUI, and menu bar in real time."
        }
    }

    public var highlights: [String] {
        switch self {
        case .sessionOrchestration: ["13 States", "Auto-Retry", "Token Tracking"]
        case .containerSecurity:    ["iptables", "Zero Git Access", "PII Scan"]
        case .multiRuntime:         ["Claude", "Codex", "Copilot"]
        case .actionControlPlane:   ["Injection Scan", "PII Redact", "Audit"]
        case .escalationSystem:     ["Browser Validate", "Human-in-Loop", "MCP"]
        case .validationPipeline:   ["7 Phases", "Self-Validate", "AC Check"]
        case .profileManagement:    ["6 Stacks", "Inheritance", "Injection"]
        case .realTimeMonitoring:   ["8 Events", "30d Replay", "PII Safe"]
        }
    }

    public var subtitle: String {
        switch self {
        case .sessionOrchestration: "13-state machine, retry logic, token tracking, and queue management"
        case .containerSecurity:    "5-layer lockdown: network, capability, user, git isolation, content scanning"
        case .multiRuntime:         "Pluggable runtimes with streaming parsers and session persistence"
        case .actionControlPlane:   "Gated actions with prompt injection detection and PII redaction"
        case .escalationSystem:     "9+ MCP tools including browser self-validation and auto-pause"
        case .validationPipeline:   "7-phase pipeline: build, test, health, smoke, AC, AI review, overall"
        case .profileManagement:    "6 stacks, 4 providers, inheritance chains, and injection pipeline"
        case .realTimeMonitoring:   "8 event types, 30-day replay, PII-safe broadcast"
        }
    }

    // MARK: - What / Why / How

    public var what: String {
        switch self {
        case .sessionOrchestration:
            "Full lifecycle management across 13 states — from task queuing through provisioning, agent execution, validation, human review, and merge. A strict state machine validates every transition, preventing impossible states like a running session that's simultaneously merging. The orchestration loop tracks token usage, monitors commit activity (polled every 60s), and handles correction feedback loops when validation fails."
        case .containerSecurity:
            "Pods are locked down at every level. Each session runs in its own Docker container on an isolated bridge network (autopod-net) with inter-container communication disabled. Per-container iptables OUTPUT chain rules control all egress. Pods run as non-root user autopod:1000 with only NET_ADMIN capability (for iptables). Pods have zero direct git access — all git operations are handled by the manager on the host, with PATs cached in-memory only and never written to any container filesystem."
        case .multiRuntime:
            "A pluggable runtime architecture supporting Anthropic Claude, OpenAI Codex, and GitHub Copilot. Each runtime implements the same interface — spawn, stream AgentEvents, resume, abort — so the orchestration pipeline is provider-agnostic. Claude supports native session persistence for resume; Codex and Copilot re-spawn with correction messages. All runtimes emit a unified 8-type event union consumed by the event bus."
        case .actionControlPlane:
            "Agents execute approved control-plane operations outside their container through a gated, audited pipeline. Every action request is validated against the registry, checked for approval requirements and resource restrictions, then dispatched to the appropriate handler (Azure, ADO, GitHub, or generic HTTP). Every response passes through prompt injection detection (7 threat patterns with compound scoring) and PII sanitization before reaching the agent. The audit trail records sanitized params, PII detection flags, and quarantine scores."
        case .escalationSystem:
            "An MCP server injected into every agent container provides 9+ tools for structured agent-human communication. Agents can ask humans (blocking), consult other AIs (rate-limited), report blockers (auto-pauses after threshold), submit plans, and report progress. The validate_in_browser tool lets agents self-validate their work — an LLM generates Playwright scripts dynamically, executes them inside the container, and captures screenshots as base64 PNGs. Dynamic action tools are registered per profile."
        case .validationPipeline:
            "A 7-phase validation pipeline runs after the agent completes: Build → Test → Health Check → Smoke (Playwright) → Acceptance Criteria (LLM evaluation) → AI Task Review → Overall Decision. Each phase gates the next. Failed validations trigger automatic retries with correction feedback injected into the agent. Passing sessions get a PR created, container preserved for human preview, and an HTML report generated with embedded screenshots. Human approval transitions to merge; rejection resets the attempt counter for a fresh run."
        case .profileManagement:
            "Profiles encode everything needed to run a session: stack template (node22, node22-pw, dotnet9, dotnet10, python312, custom), execution target (Docker or ACI), model provider (Anthropic, MAX/PRO, Foundry, Copilot), network policy, output mode (PR, artifact, workspace), and all injections. Inheritance chains (up to 5 levels) with special merge logic for skills, MCP servers, CLAUDE.md sections, smoke pages, and registries. The system-instructions-generator builds a complete CLAUDE.md with priority-sorted sections, dynamic content fetches, and PII sanitization."
        case .realTimeMonitoring:
            "WebSocket event streaming delivers 8 event types to all connected clients: session.created, status_changed, agent_activity, validation_started, validation_completed, escalation_created, escalation_resolved, and session.completed. Events are persisted for 30-day replay, PII-sanitized before broadcast, and delivered with monotonic event IDs for gap detection. Clients subscribe per-session or globally, with 30-second heartbeat pings and automatic reconnection."
        }
    }

    public var why: String {
        switch self {
        case .sessionOrchestration:
            "Without a state machine, sessions could end up in impossible states — a running session that's also merging, a killed session that suddenly completes. The orchestration loop ensures every session follows the correct path, retries failures automatically with correction feedback, and tracks costs via token usage. Recovery mode even lets killed sessions resume validation if the worktree is preserved."
        case .containerSecurity:
            "AI agents running arbitrary code need defense-in-depth, not just trust. A compromised agent shouldn't reach internal services, exfiltrate data, interfere with other sessions, or access git credentials. Five layers enforce this: network (iptables egress), capability (minimal caps), user (non-root), git (host-side only, PATs never in container), and content (PII/injection scanning). Shell injection is prevented in iptables rules via SAFE_HOST_REGEX validation on all hostnames."
        case .multiRuntime:
            "Different tasks benefit from different models. Claude excels at complex reasoning, Codex at code generation, Copilot at incremental changes. By abstracting the runtime behind a common interface, teams choose the best model per profile without changing orchestration logic. Session persistence (Claude) enables efficient resume after escalation or validation failure."
        case .actionControlPlane:
            "Agents need to interact with the real world — trigger deployments, update work items, create PRs — but direct API access is a massive security risk. The ACP provides a controlled gateway where every request is validated, every response is scanned for prompt injection (7 patterns with compound threat scoring) and PII (API keys, AWS keys, emails, etc.), and everything is audit-logged. Quarantined content is wrapped with untrusted markers or blocked entirely above 0.8 threat score."
        case .escalationSystem:
            "Fully autonomous agents hit blockers — ambiguous requirements, missing credentials, architectural decisions needing human judgment. Without structured escalation, agents guess and produce wrong output. The escalation system provides blocking tools (ask_human waits for response), rate-limited AI consultation, auto-pause after repeated blockers, and browser self-validation so agents can verify their own work before human review."
        case .validationPipeline:
            "Trusting AI-generated code without validation is dangerous. The 7-phase pipeline catches issues at every level: build failures, test regressions, health check failures, visual smoke test regressions, acceptance criteria violations, and subtle code quality issues. Agents can self-validate with validate_in_browser during development. The correction feedback loop means agents learn from validation failures and fix their own mistakes before human review."
        case .profileManagement:
            "Every project has different stacks, registries, network rules, credentials, and AI providers. Profiles encode these differences for reproducible sessions. Inheritance (up to 5 levels) prevents config duplication — a base profile handles shared settings while child profiles override specifics. Special merge logic ensures skills, MCP servers, and smoke pages accumulate rather than replace, while credentials and network policies take the child's value."
        case .realTimeMonitoring:
            "When an agent is running autonomously, you need to know what it's doing right now — not after it finishes. Real-time streaming lets operators catch problems early, respond to escalations within the agent's timeout window, and maintain confidence in autonomous operations. Event replay with 30-day retention ensures no data loss on reconnection. PII sanitization on events prevents sensitive data from leaking to clients."
        }
    }

    public var how: String {
        switch self {
        case .sessionOrchestration:
            "The session manager's processSession() loop provisions containers, launches the runtime, consumes AgentEvents, monitors escalations, triggers validation, and handles retries. Token usage is captured from AgentCompleteEvents. Commit activity is polled every 60s via git rev-list inside the container. Failed validations feed correction messages back to the agent via runtime.resume()."
        case .containerSecurity:
            "Containers spawn on an isolated Docker bridge (autopod-net, ICC disabled). The docker-network-manager generates iptables scripts with OUTPUT chain rules: flush → allow loopback → allow established/related → mode-specific rules → final DROP. Git repos are cloned as bare repos with auth URLs, then immediately stripped (git remote set-url origin <cleanUrl>). PATs are cached in-memory only with per-repo mutex locks. Images can be prewarmed (7-day staleness threshold) with credentials stripped post-build."
        case .multiRuntime:
            "Each runtime streams events via its provider's format. Claude uses NDJSON (--output-format stream-json) with session ID persistence for resume. Codex uses JSONL (--json flag). Copilot streams plain text lines. All parsers emit the same AgentEvent union: status, tool_use, file_change, complete, error, escalation, plan, progress."
        case .actionControlPlane:
            "Agent calls execute_action MCP tool → engine resolves action definition → checks approval gate and resource restrictions → validates params → dispatches to handler → response passes through quarantine() for injection detection (7 patterns, compound scoring: max severity + 0.1 bonus per additional pattern) → then sanitize() for PII (API keys, AWS keys, Azure connections, emails, field-level redaction) → audit logged with piiDetected flag and quarantineScore → response returned to agent."
        case .escalationSystem:
            "The MCP server registers tools at container startup. Blocking tools (ask_human, report_blocker, validate_in_browser) use PendingRequests — a Promise-based map where the agent awaits resolution. The daemon resolves via API when a human responds. For validate_in_browser: an LLM generates a Playwright ESM script → written to /tmp/autopod-browser-check.mjs → executed via node → results parsed from stdout markers → screenshots collected from /tmp/autopod-browser-checks/check-{n}.png as base64."
        case .validationPipeline:
            "Seven sequential phases with gating: (1) Build — runs profile.buildCommand with configurable timeout, (2) Test — runs profile.testCommand if build passes, (3) Health Check — polls healthCheckUrl for HTTP 200, (4) Smoke — Playwright scripts generated from smokePages definitions, (5) Acceptance Criteria — LLM evaluates each criterion against the running app, (6) AI Task Review — reviewer model checks diff + task description, (7) Overall — pass only if all required phases pass. Failed validations reset to running with correction feedback (up to maxValidationAttempts, default 3)."
        case .profileManagement:
            "Profile resolution: inheritance chain walked (max 5 levels), fields merged with special logic for arrays/objects. Skills resolved from GitHub APIs or local files (Promise.allSettled, failures logged and skipped). Registry injection generates .npmrc and NuGet.Config with immediate validation (npm config list / dotnet nuget list source). MCP server URLs rewritten to daemon proxy endpoints. CLAUDE.md built from: task → injected sections (priority-sorted, dynamic-fetched) → MCP tools → skills → acceptance criteria → workflow requirements."
        case .realTimeMonitoring:
            "The event bus persists events to eventRepository, applies processContentDeep() for PII sanitization, then broadcasts to subscribers. WebSocket connections authenticate via token query param, then send subscribe/unsubscribe/replay messages. Events include monotonic _eventId for ordered replay. Heartbeat pings every 30s detect stale connections. Desktop, CLI, and menu bar consume the same protocol — subscribe to sessions on selection, receive AgentActivityEvents for live tool use display."
        }
    }

    public var howBullets: [String] {
        switch self {
        case .sessionOrchestration:
            [
                "13 states: queued → provisioning → running → validating → validated → approved → merging → complete (plus awaiting_input, paused, failed, killing, killed)",
                "Configurable MAX_CONCURRENCY for queue management",
                "Automatic retry on validation failure with correction feedback to agent",
                "Token usage + cost tracking from AgentCompleteEvent",
                "Commit polling every 60s (git rev-list count + last commit timestamp)",
                "Workspace pods: interactive containers, no agent, auto-push on exit",
                "Recovery mode: killed sessions can resume validation if worktree preserved",
                "Escalation auto-pause after configurable threshold (default 3)",
            ]
        case .containerSecurity:
            [
                "Network: autopod-net bridge with ICC disabled, iptables OUTPUT chain per container",
                "allow-all: loopback + established/related, no DROP (trusted environments)",
                "deny-all: DNS only (UDP/TCP 53), everything else DROPped",
                "restricted: per-host allowlist resolved via getent ahosts, final DROP",
                "Default allowlist: api.anthropic.com, api.openai.com, registry.npmjs.org, github.com, pkgs.dev.azure.com, etc.",
                "Capability: only NET_ADMIN added (for iptables), no other Docker capabilities",
                "User: non-root autopod:1000, /workspace working dir, restricted mounts",
                "Git: bare repos with PATs stripped, in-memory PAT cache on host, per-repo mutex",
                "Shell injection defense: SAFE_HOST_REGEX validates all hostnames before iptables injection",
                "Image prewarming: 7-day staleness, credentials stripped post-build, ACR push",
            ]
        case .multiRuntime:
            [
                "Claude: NDJSON streaming (stream-json), session ID persistence, native resume",
                "Codex: JSONL streaming (--json flag), fresh spawn on resume",
                "Copilot: plain text lines, copilot-instructions.md config, re-spawn with correction",
                "8 AgentEvent types: status, tool_use, file_change, complete, error, escalation, plan, progress",
                "Provider credentials: Anthropic (API key), MAX (OAuth + refresh), Foundry (Azure endpoint), Copilot (GitHub token)",
                "Config files auto-generated: .claude.json (onboarding skip), .credentials.json (OAuth)",
            ]
        case .actionControlPlane:
            [
                "5 built-in action groups: github-prs, github-issues, github-code, ado-workitems, azure-logs",
                "4 handlers: Azure (ARM), ADO (REST), GitHub (API), generic HTTP (templates)",
                "Approval gates: per-action requiresApproval flag blocks execution, routes to ask_human",
                "Resource restrictions: allowedResources limits which repos/resources actions can target",
                "Prompt injection: 7 patterns (direct-instruction, role-manipulation, token-boundary, exfiltration, tool-abuse, encoding-trick, xml-tag-injection)",
                "Threat scoring: max severity + compound bonus (up to +0.2), three tiers: pass (<0.5) / quarantine-wrap (0.5-0.8) / block (>0.8)",
                "PII redaction: API keys, AWS keys, Azure connections, emails, plus field-level (password, secret, token, api_key, private_key)",
                "Audit: sessionId, actionName, sanitized params, response summary, piiDetected, quarantineScore, timestamp",
            ]
        case .escalationSystem:
            [
                "ask_human — Blocking: pauses agent, waits for human response or timeout",
                "ask_ai — Rate-limited: calls reviewer model, max N calls per session",
                "report_blocker — Conditionally blocking: auto-pauses after threshold escalations",
                "report_plan — Fire-and-forget: submits plan summary + steps",
                "report_progress — Fire-and-forget: reports phase transitions",
                "check_messages — Non-blocking: polls for pending human messages without pausing",
                "validate_in_browser — Blocking: LLM generates Playwright script → executes in container → captures screenshots as base64",
                "trigger_revalidation — Workspace pods only: re-runs validation on linked failed worker",
                "Dynamic action tools — One MCP tool per ActionDefinition from profile's action policy",
            ]
        case .validationPipeline:
            [
                "Phase 1 — Build: runs profile.buildCommand (default timeout 300s), gates all downstream",
                "Phase 2 — Test: runs profile.testCommand (default timeout 600s), requires build pass",
                "Phase 3 — Health Check: polls healthCheckUrl for HTTP 200, configurable timeout",
                "Phase 4 — Smoke: Playwright scripts from smokePages, captures screenshots + console errors",
                "Phase 5 — Acceptance Criteria: LLM evaluates each criterion against running app",
                "Phase 6 — AI Task Review: reviewer model checks diff for correctness, style, security",
                "Phase 7 — Overall: pass only if all required phases pass, strictly binary",
                "Agent self-validation: validate_in_browser MCP tool during development",
                "Retry loop: correction feedback + diff injected into agent, up to maxValidationAttempts (default 3)",
                "Human review: HTML report with Tailwind, embedded screenshots, container preserved for preview",
                "Rejection resets attempt counter for fresh agent run",
            ]
        case .profileManagement:
            [
                "6 stack templates: node22, node22-pw, dotnet9, dotnet10, python312, custom",
                "3 output modes: pr (full pipeline), artifact (research-output.md), workspace (interactive)",
                "4 model providers: Anthropic (API key), MAX/PRO (OAuth + token refresh), Foundry (Azure endpoint), Copilot (GitHub token)",
                "Inheritance: up to 5 levels, fields that never inherit: name, extends, timestamps",
                "Special merge: skills/MCP servers merge by name (child wins), smokePages append, escalation deep-merges, customInstructions concatenate",
                "Skill resolution: GitHub API fetch (15s timeout) or local file read, failures logged + skipped",
                "Registry injection: .npmrc / NuGet.Config generated, immediately validated (npm config list / dotnet nuget list source)",
                "MCP proxy: profile MCP URLs rewritten to daemon proxy endpoints with auth injection",
                "CLAUDE.md: task → sections (priority-sorted) → MCP tools → skills → AC → workflow rules",
                "Credentials: AES-256-GCM at rest, key at ~/.autopod/secrets.key (0600 perms)",
            ]
        case .realTimeMonitoring:
            [
                "8 SystemEvent types: session.created, status_changed, agent_activity, validation_started, validation_completed, escalation_created, escalation_resolved, session.completed",
                "Event persistence: 30-day retention, monotonic event IDs, gap-free replay",
                "PII sanitization: processContentDeep() strips sensitive data before broadcast",
                "WebSocket protocol: subscribe/unsubscribe per-session, subscribe_all, replay from lastEventId",
                "Heartbeat: 30-second ping/pong cycle, stale connection cleanup",
                "Desktop app: live session monitoring with event stream + terminal access",
                "CLI TUI: Ink/React dashboard with keyboard shortcuts",
                "Menu bar: attention count badge, quick session access",
            ]
        }
    }

    public var keyFiles: [String] {
        switch self {
        case .sessionOrchestration:
            ["session-manager.ts", "state-machine.ts", "session-repository.ts", "event-bus.ts"]
        case .containerSecurity:
            ["docker-container-manager.ts", "docker-network-manager.ts", "aci-container-manager.ts", "processor.ts", "quarantine.ts", "patterns.ts"]
        case .multiRuntime:
            ["claude-runtime.ts", "codex-runtime.ts", "copilot-runtime.ts", "claude-stream-parser.ts", "env-builder.ts"]
        case .actionControlPlane:
            ["action-engine.ts", "action-registry.ts", "action-audit-repository.ts", "processor.ts", "quarantine.ts"]
        case .escalationSystem:
            ["server.ts", "session-bridge.ts", "pending-requests.ts", "validate-in-browser.ts", "ask-human.ts"]
        case .validationPipeline:
            ["local-validation-engine.ts", "playwright-script.ts", "parse-results.ts", "report-generator.ts"]
        case .profileManagement:
            ["profile-store.ts", "inheritance.ts", "skill-resolver.ts", "system-instructions-generator.ts", "registry-injector.ts", "credentials-cipher.ts"]
        case .realTimeMonitoring:
            ["event-bus.ts", "websocket.ts", "EventStream.swift", "useWebSocket.ts"]
        }
    }

    public var relatedFeatures: [FeatureCategory] {
        switch self {
        case .sessionOrchestration: [.containerSecurity, .validationPipeline, .escalationSystem]
        case .containerSecurity:    [.actionControlPlane, .profileManagement]
        case .multiRuntime:         [.sessionOrchestration, .escalationSystem]
        case .actionControlPlane:   [.escalationSystem, .containerSecurity]
        case .escalationSystem:     [.actionControlPlane, .validationPipeline]
        case .validationPipeline:   [.escalationSystem, .sessionOrchestration]
        case .profileManagement:    [.containerSecurity, .multiRuntime]
        case .realTimeMonitoring:   [.sessionOrchestration, .escalationSystem]
        }
    }
}

// MARK: - Preview

#Preview("Feature Overview") {
    @Previewable @State var selected: FeatureCategory? = nil
    FeatureOverviewView(selectedFeature: $selected)
        .frame(width: 900, height: 800)
}
