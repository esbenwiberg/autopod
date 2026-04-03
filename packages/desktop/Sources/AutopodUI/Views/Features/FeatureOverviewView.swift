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
        case .sessionOrchestration: ["State Machine", "Auto-Retry", "Queue"]
        case .containerSecurity:    ["iptables", "Isolation", "Allowlists"]
        case .multiRuntime:         ["Claude", "Codex", "Copilot"]
        case .actionControlPlane:   ["Azure", "ADO", "GitHub", "Audit"]
        case .escalationSystem:     ["MCP", "Human-in-Loop", "AI Consult"]
        case .validationPipeline:   ["Playwright", "Tests", "AI Review"]
        case .profileManagement:    ["Templates", "Injection", "Inheritance"]
        case .realTimeMonitoring:   ["WebSocket", "Streaming", "Live"]
        }
    }

    public var subtitle: String {
        switch self {
        case .sessionOrchestration: "State machine, transitions, retry logic, and queue management"
        case .containerSecurity:    "Docker isolation, iptables firewalling, and network policy modes"
        case .multiRuntime:         "Pluggable agent runtimes with SSE streaming and event parsing"
        case .actionControlPlane:   "Agent-triggered actions with handlers, registry, and audit trail"
        case .escalationSystem:     "MCP tools injected into containers for human-in-the-loop flows"
        case .validationPipeline:   "Playwright smoke tests, build checks, and AI code review"
        case .profileManagement:    "Stack templates, skill resolution, CLAUDE.md generation, and registry injection"
        case .realTimeMonitoring:   "WebSocket event streaming with real-time UI updates"
        }
    }

    // MARK: - What / Why / How

    public var what: String {
        switch self {
        case .sessionOrchestration:
            "Full lifecycle management from task queuing through provisioning, agent execution, validation, human review, and merge. Every session transition is validated by a strict state machine — invalid transitions are rejected, preventing corrupted session states."
        case .containerSecurity:
            "Every session runs in its own Docker container with per-container iptables firewall rules. The docker-network-manager applies firewall rules at container creation, giving granular control over what agents can access on the network."
        case .multiRuntime:
            "A pluggable runtime architecture that supports Anthropic Claude, OpenAI Codex, and GitHub Copilot. Each runtime implements a common interface — start an agent, stream structured events, handle termination — so the orchestration pipeline stays the same regardless of provider."
        case .actionControlPlane:
            "A system that lets agents execute approved control-plane operations outside their container — Azure deployments, ADO pipeline triggers, GitHub PR operations, and generic HTTP calls. Every execution is validated against the action registry and recorded in a full audit trail."
        case .escalationSystem:
            "An MCP (Model Context Protocol) server injected into every agent container at startup. It provides tools that let the agent communicate with the control plane — the daemon — without direct network access. Agents can ask humans, consult other AIs, report blockers, and submit plans."
        case .validationPipeline:
            "A multi-stage validation pipeline that runs after the agent completes its work. Playwright smoke tests verify the running application, unit tests validate correctness, and AI-powered code review checks for quality and security issues. All three stages must pass before merge."
        case .profileManagement:
            "Profiles are the unit of configuration in Autopod. They define everything needed to run a session: stack templates, credentials, network policies, private registries, skill injection, and MCP server configuration. Profile inheritance lets you share defaults across teams."
        case .realTimeMonitoring:
            "WebSocket-based event streaming that delivers agent activity, status transitions, escalation events, and tool use to all connected clients in real time. The desktop app, CLI TUI, and menu bar all receive the same live event stream."
        }
    }

    public var why: String {
        switch self {
        case .sessionOrchestration:
            "Without a state machine, sessions could end up in impossible states — a running session that's also merging, a killed session that suddenly completes. The orchestration loop ensures every session follows the correct path, retries failures automatically, and never loses work."
        case .containerSecurity:
            "AI agents running arbitrary code need strict isolation. A compromised or misbehaving agent shouldn't be able to reach internal services, exfiltrate data, or interfere with other sessions. Per-container firewall rules enforce this at the network level, not just through trust."
        case .multiRuntime:
            "Different tasks benefit from different models. Claude excels at complex reasoning, Codex at code completion, Copilot at incremental changes. By abstracting the runtime, teams can choose the best model per profile without changing any orchestration logic."
        case .actionControlPlane:
            "Agents need to interact with the real world — trigger deployments, update work items, create PRs — but giving them direct API access is a security risk. The action control plane provides a controlled, audited gateway for these operations."
        case .escalationSystem:
            "Fully autonomous agents hit blockers — ambiguous requirements, missing credentials, architectural decisions that need human judgment. The escalation system gives agents a structured way to pause and ask for help instead of guessing and producing wrong output."
        case .validationPipeline:
            "Trusting AI-generated code without validation is dangerous. Automated smoke tests catch runtime errors, unit tests catch logic bugs, and AI review catches subtle issues a test suite might miss. This multi-layer approach is what makes autonomous merge safe."
        case .profileManagement:
            "Every project has different needs — different stacks, registries, network rules, credentials. Profiles encode these differences so sessions are reproducible and teams don't have to reconfigure from scratch. Inheritance prevents config duplication across similar projects."
        case .realTimeMonitoring:
            "When an agent is running autonomously, you need to know what it's doing right now — not after it finishes. Real-time streaming lets operators catch problems early, respond to escalations quickly, and maintain confidence in what the system is doing."
        }
    }

    public var how: String {
        switch self {
        case .sessionOrchestration:
            "The session manager's processSession() loop is the core engine. It provisions containers, launches the agent runtime, monitors for escalations, triggers validation, and handles the full lifecycle including retries on failure."
        case .containerSecurity:
            "Each session gets its own Docker container via Dockerode. The docker-network-manager applies iptables rules based on the profile's network policy configuration."
        case .multiRuntime:
            "Each runtime has a dedicated stream parser that handles the provider's specific format (SSE for Claude, NDJSON for Codex). All parsers emit the same AgentEvent union type consumed by the event bus."
        case .actionControlPlane:
            "When an agent calls the execute_action MCP tool, the request flows through the action engine, which validates it against the registry, executes via the appropriate handler, and records the result in the audit trail."
        case .escalationSystem:
            "The SessionBridge interface links MCP tool calls to daemon internals. Pending requests are tracked asynchronously, allowing agents to block until a human responds. The server is configured via environment variables injected at container creation."
        case .validationPipeline:
            "The validator package generates Playwright test scripts dynamically based on the session's acceptance criteria. Scripts are injected into the container and executed by the daemon's validation engine. Results are parsed from Playwright's JSON output format."
        case .profileManagement:
            "The system-instructions-generator builds the CLAUDE.md file placed inside each container. It combines profile skill content, injected sections (resolved by section-resolver), and standard instructions into a coherent operating manual for the agent."
        case .realTimeMonitoring:
            "The event bus publishes every state change, tool use, and escalation. WebSocket connections subscribe to specific sessions and receive events as they happen. The desktop app and CLI both consume the same event stream protocol."
        }
    }

    public var howBullets: [String] {
        switch self {
        case .sessionOrchestration:
            [
                "Queue management with configurable MAX_CONCURRENCY",
                "Automatic retry on validation failure with attempt tracking",
                "Workspace pods follow a simplified flow without agent execution",
                "Event bus publishes every state change for real-time streaming",
            ]
        case .containerSecurity:
            [
                "allow-all: Unrestricted outbound access (default for trusted environments)",
                "deny-all: No outbound network access whatsoever",
                "restricted: Allowlist of specific hosts and ports for production use",
                "Git repos mounted as bare clones with PATs stripped from remote URLs",
            ]
        case .multiRuntime:
            [
                "Claude Runtime — Anthropic API with SSE streaming, full tool use support",
                "Codex Runtime — OpenAI API with NDJSON streaming",
                "Copilot Runtime — GitHub Copilot API integration",
            ]
        case .actionControlPlane:
            [
                "Azure handler: ARM deployments, resource management",
                "ADO handler: Pipeline triggers, work item updates",
                "GitHub handler: PR operations, issue management, workflow dispatch",
                "HTTP handler: Generic webhook/API calls for custom integrations",
            ]
        case .escalationSystem:
            [
                "ask_human — Pause and wait for human input (blocks the agent)",
                "ask_ai — Consult another AI model for a second opinion",
                "report_blocker — Flag an issue that prevents progress",
                "report_plan — Submit the implementation plan before starting work",
                "report_progress — Report phase transitions during execution",
            ]
        case .validationPipeline:
            [
                "Smoke Tests — Playwright scripts test the app in a real browser",
                "Build & Unit Tests — Standard test suite execution inside the container",
                "AI Code Review — An AI model reviews the diff for correctness and security",
            ]
        case .profileManagement:
            [
                "Stack templates define the base image and toolchain",
                "Network policy per profile (allow-all, deny-all, restricted)",
                "Private registry configuration for ADO feeds (.npmrc / NuGet.config)",
                "Profile inheritance — extend a base profile and override specific settings",
            ]
        case .realTimeMonitoring:
            [
                "Desktop app receives events for live session monitoring",
                "CLI TUI dashboard with keyboard shortcuts for session management",
                "Menu bar extra shows attention count at a glance",
                "WebSocket auto-reconnect with state recovery",
            ]
        }
    }

    public var keyFiles: [String] {
        switch self {
        case .sessionOrchestration:
            ["session-manager.ts", "state-machine.ts", "session-repository.ts", "event-bus.ts"]
        case .containerSecurity:
            ["docker-container-manager.ts", "docker-network-manager.ts", "aci-container-manager.ts"]
        case .multiRuntime:
            ["claude-runtime.ts", "codex-runtime.ts", "copilot-runtime.ts"]
        case .actionControlPlane:
            ["action-engine.ts", "action-registry.ts", "action-audit-repository.ts"]
        case .escalationSystem:
            ["server.ts", "session-bridge.ts", "pending-requests.ts"]
        case .validationPipeline:
            ["local-validation-engine.ts", "playwright-script.ts", "parse-results.ts"]
        case .profileManagement:
            ["profile-store.ts", "skill-resolver.ts", "system-instructions-generator.ts", "registry-injector.ts"]
        case .realTimeMonitoring:
            ["event-bus.ts", "websocket.ts", "EventStream.swift", "useWebSocket.ts"]
        }
    }

    public var relatedFeatures: [FeatureCategory] {
        switch self {
        case .sessionOrchestration: [.containerSecurity, .validationPipeline]
        case .containerSecurity:    [.sessionOrchestration, .profileManagement]
        case .multiRuntime:         [.sessionOrchestration, .escalationSystem]
        case .actionControlPlane:   [.escalationSystem, .profileManagement]
        case .escalationSystem:     [.actionControlPlane, .sessionOrchestration]
        case .validationPipeline:   [.sessionOrchestration, .multiRuntime]
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
