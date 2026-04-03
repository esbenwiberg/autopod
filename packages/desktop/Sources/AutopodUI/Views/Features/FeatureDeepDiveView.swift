import SwiftUI

/// Deep-dive feature documentation with expandable sections and detailed explanations.
public struct FeatureDeepDiveView: View {
    @State private var expandedSection: DeepDiveSection?
    @State private var searchText = ""

    public init() {}

    private var filteredSections: [DeepDiveSection] {
        guard !searchText.isEmpty else { return DeepDiveSection.allCases }
        let query = searchText.lowercased()
        return DeepDiveSection.allCases.filter { section in
            section.title.lowercased().contains(query)
                || section.subtitle.lowercased().contains(query)
                || section.details.contains { $0.title.lowercased().contains(query) || $0.body.lowercased().contains(query) }
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Deep Dive")
                    .font(.title2.weight(.semibold))
                Text("Explore every system in detail")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                TextField("Search topics...", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.caption)
                    .frame(width: 140)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 7))
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }

    // MARK: - Content

    private var content: some View {
        ScrollView {
            VStack(spacing: 10) {
                ForEach(filteredSections) { section in
                    sectionCard(section)
                }

                if filteredSections.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 24))
                            .foregroundStyle(.tertiary)
                        Text("No matching topics")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
        }
    }

    // MARK: - Section card

    private func sectionCard(_ section: DeepDiveSection) -> some View {
        let isExpanded = expandedSection == section

        return VStack(alignment: .leading, spacing: 0) {
            // Header row — always visible
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    expandedSection = isExpanded ? nil : section
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: section.icon)
                        .font(.system(size: 14))
                        .foregroundStyle(section.color)
                        .frame(width: 32, height: 32)
                        .background(section.color.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: 7))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(section.title)
                            .font(.system(.body).weight(.semibold))
                            .foregroundStyle(.primary)
                        Text(section.subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer()

                    // Key files count badge
                    if !section.keyFiles.isEmpty {
                        Text("\(section.keyFiles.count) files")
                            .font(.system(.caption2).weight(.medium))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(section.color.opacity(0.08))
                            .foregroundStyle(section.color)
                            .clipShape(Capsule())
                    }

                    Image(systemName: "chevron.right")
                        .font(.system(size: 10).weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(14)

            // Expanded content
            if isExpanded {
                Divider()
                    .padding(.horizontal, 14)

                VStack(alignment: .leading, spacing: 16) {
                    // Detail blocks
                    ForEach(Array(section.details.enumerated()), id: \.offset) { _, detail in
                        detailBlock(detail, accentColor: section.color)
                    }

                    // Key files
                    if !section.keyFiles.isEmpty {
                        keyFilesBlock(section.keyFiles, color: section.color)
                    }

                    // Related concepts
                    if !section.relatedSections.isEmpty {
                        relatedBlock(section.relatedSections)
                    }
                }
                .padding(14)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Detail block

    private func detailBlock(_ detail: DeepDiveDetail, accentColor: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(accentColor.opacity(0.5))
                    .frame(width: 3, height: 14)
                Text(detail.title)
                    .font(.system(.subheadline).weight(.semibold))
            }

            Text(detail.body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            if !detail.bullets.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(detail.bullets, id: \.self) { bullet in
                        HStack(alignment: .top, spacing: 6) {
                            Circle()
                                .fill(accentColor.opacity(0.4))
                                .frame(width: 4, height: 4)
                                .padding(.top, 5)
                            Text(bullet)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineSpacing(2)
                        }
                    }
                }
                .padding(.leading, 4)
            }

            if let code = detail.codeSnippet {
                Text(code)
                    .font(.system(.caption2, design: .monospaced))
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.black.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    // MARK: - Key files block

    private func keyFilesBlock(_ files: [String], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Key Files")
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)

            FlowLayoutCompact(spacing: 6) {
                ForEach(files, id: \.self) { file in
                    Text(file)
                        .font(.system(.caption2, design: .monospaced))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(color.opacity(0.06))
                        .foregroundStyle(color.opacity(0.8))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                }
            }
        }
    }

    // MARK: - Related sections

    private func relatedBlock(_ related: [DeepDiveSection]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Related")
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                ForEach(related) { section in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            expandedSection = section
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: section.icon)
                                .font(.system(size: 9))
                            Text(section.title)
                                .font(.caption2)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(section.color.opacity(0.08))
                        .foregroundStyle(section.color)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

// MARK: - Flow layout (compact variant for file tags)

private struct FlowLayoutCompact: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var height: CGFloat = 0
        for (index, row) in rows.enumerated() {
            let rowHeight = row.map { subviews[$0].sizeThatFits(.unspecified).height }.max() ?? 0
            height += rowHeight
            if index < rows.count - 1 { height += spacing }
        }
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            let rowHeight = row.map { subviews[$0].sizeThatFits(.unspecified).height }.max() ?? 0
            var x = bounds.minX
            for index in row {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += rowHeight + spacing
        }
    }

    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [[Int]] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [[Int]] = [[]]
        var currentWidth: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if currentWidth + size.width > maxWidth && !rows[rows.count - 1].isEmpty {
                rows.append([])
                currentWidth = 0
            }
            rows[rows.count - 1].append(index)
            currentWidth += size.width + spacing
        }
        return rows
    }
}

// MARK: - Detail model

struct DeepDiveDetail {
    let title: String
    let body: String
    var bullets: [String] = []
    var codeSnippet: String? = nil
}

// MARK: - Deep-dive sections

enum DeepDiveSection: String, CaseIterable, Identifiable {
    case sessionLifecycle
    case containerNetwork
    case actionControlPlane
    case escalationMcp
    case validationEngine
    case runtimeArchitecture
    case profileInjection
    case credentialSecurity

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sessionLifecycle:     "Session Lifecycle"
        case .containerNetwork:     "Container & Network Security"
        case .actionControlPlane:   "Action Control Plane"
        case .escalationMcp:        "Escalation MCP Server"
        case .validationEngine:     "Validation Engine"
        case .runtimeArchitecture:  "Runtime Architecture"
        case .profileInjection:     "Profiles & Injection"
        case .credentialSecurity:   "Credential Security"
        }
    }

    var subtitle: String {
        switch self {
        case .sessionLifecycle:     "State machine, transitions, retry logic, and queue management"
        case .containerNetwork:     "Docker isolation, iptables firewalling, and network policy modes"
        case .actionControlPlane:   "Agent-triggered actions with handlers, registry, and audit trail"
        case .escalationMcp:        "MCP tools injected into containers for human-in-the-loop flows"
        case .validationEngine:     "Playwright smoke tests, build checks, and AI code review"
        case .runtimeArchitecture:  "Pluggable agent runtimes with SSE streaming and event parsing"
        case .profileInjection:     "Stack templates, skill resolution, CLAUDE.md generation, and registry injection"
        case .credentialSecurity:   "AES-256 encryption, HMAC tokens, PII sanitization, and PAT stripping"
        }
    }

    var icon: String {
        switch self {
        case .sessionLifecycle:     "arrow.triangle.2.circlepath"
        case .containerNetwork:     "lock.shield"
        case .actionControlPlane:   "slider.horizontal.3"
        case .escalationMcp:        "bubble.left.and.exclamationmark.bubble.right"
        case .validationEngine:     "checkmark.shield"
        case .runtimeArchitecture:  "cpu"
        case .profileInjection:     "folder.badge.gearshape"
        case .credentialSecurity:   "key.fill"
        }
    }

    var color: Color {
        switch self {
        case .sessionLifecycle:     .blue
        case .containerNetwork:     .red
        case .actionControlPlane:   .purple
        case .escalationMcp:        .orange
        case .validationEngine:     .green
        case .runtimeArchitecture:  .cyan
        case .profileInjection:     .indigo
        case .credentialSecurity:   .pink
        }
    }

    var keyFiles: [String] {
        switch self {
        case .sessionLifecycle:
            ["session-manager.ts", "state-machine.ts", "session-repository.ts", "event-bus.ts"]
        case .containerNetwork:
            ["docker-container-manager.ts", "docker-network-manager.ts", "aci-container-manager.ts"]
        case .actionControlPlane:
            ["action-engine.ts", "action-registry.ts", "action-audit-repository.ts"]
        case .escalationMcp:
            ["server.ts", "session-bridge.ts", "pending-requests.ts"]
        case .validationEngine:
            ["local-validation-engine.ts", "playwright-script.ts", "parse-results.ts"]
        case .runtimeArchitecture:
            ["claude-runtime.ts", "codex-runtime.ts", "copilot-runtime.ts"]
        case .profileInjection:
            ["profile-store.ts", "skill-resolver.ts", "system-instructions-generator.ts", "registry-injector.ts"]
        case .credentialSecurity:
            ["credentials-cipher.ts", "session-tokens.ts", "sanitize/processor.ts"]
        }
    }

    var relatedSections: [DeepDiveSection] {
        switch self {
        case .sessionLifecycle:     [.containerNetwork, .validationEngine]
        case .containerNetwork:     [.credentialSecurity, .sessionLifecycle]
        case .actionControlPlane:   [.escalationMcp, .credentialSecurity]
        case .escalationMcp:        [.actionControlPlane, .sessionLifecycle]
        case .validationEngine:     [.sessionLifecycle, .runtimeArchitecture]
        case .runtimeArchitecture:  [.sessionLifecycle, .escalationMcp]
        case .profileInjection:     [.containerNetwork, .credentialSecurity]
        case .credentialSecurity:   [.containerNetwork, .profileInjection]
        }
    }

    // swiftlint:disable function_body_length
    var details: [DeepDiveDetail] {
        switch self {

        case .sessionLifecycle:
            [
                DeepDiveDetail(
                    title: "State Machine",
                    body: "Every session transition is validated by a strict state machine. Invalid transitions are rejected, preventing corrupted session states. The state machine defines which transitions are legal and enforces them at the repository layer.",
                    codeSnippet: "queued -> provisioning -> running -> validating -> validated -> approved -> merging -> complete"
                ),
                DeepDiveDetail(
                    title: "Orchestration Loop",
                    body: "The session manager's processSession() loop is the core engine (~2000 lines). It provisions containers, launches the agent runtime, monitors for escalations, triggers validation, and handles the full lifecycle including retries on failure.",
                    bullets: [
                        "Queue management with configurable MAX_CONCURRENCY",
                        "Automatic retry on validation failure with attempt tracking",
                        "Workspace pods follow a simplified flow without agent execution",
                        "Event bus publishes every state change for real-time streaming",
                    ]
                ),
                DeepDiveDetail(
                    title: "Workspace Pod Flow",
                    body: "Workspace pods are interactive containers without an agent. A human connects via terminal, does their work, and the branch is auto-pushed on exit. Workspaces can be handed off to worker sessions for automated completion.",
                    codeSnippet: "queued -> provisioning -> running (interactive) -> complete (auto-push)"
                ),
            ]

        case .containerNetwork:
            [
                DeepDiveDetail(
                    title: "Docker Isolation",
                    body: "Each session gets its own Docker container via Dockerode. Containers are provisioned with resource limits, mounted volumes (bare git repos with PATs stripped), and injected configuration files. The container manager handles spawn, kill, exec, file I/O, and log streaming.",
                    bullets: [
                        "Git repos mounted as bare clones with PATs stripped from remote URLs",
                        "Non-root user 'autopod' (UID 1000) inside containers",
                        "Resource limits per profile configuration",
                        "Log streaming for real-time agent monitoring",
                    ]
                ),
                DeepDiveDetail(
                    title: "Network Policy Modes",
                    body: "The docker-network-manager applies per-container iptables firewall rules. Three modes give granular control over outbound network access from agent containers.",
                    bullets: [
                        "allow-all: Unrestricted outbound access (default for trusted environments)",
                        "deny-all: No outbound network access whatsoever",
                        "restricted: Allowlist of specific hosts and ports — the most secure option for production use",
                    ]
                ),
                DeepDiveDetail(
                    title: "Azure Container Instances",
                    body: "For cloud-native deployments, the ACI container manager provides an alternative backend. Sessions can target Docker or ACI via the profile's execution_target setting, enabling hybrid local/cloud orchestration."
                ),
            ]

        case .actionControlPlane:
            [
                DeepDiveDetail(
                    title: "How Actions Work",
                    body: "The action system lets agents execute control-plane operations outside their container. When an agent calls the execute_action MCP tool, the request flows through the action engine, which validates it against the registry, executes via the appropriate handler, and records the result in the audit trail.",
                    bullets: [
                        "Action definitions specify name, parameters, required approvals, and allowed profiles",
                        "The action registry manages available actions per profile",
                        "Every execution is logged in the action-audit-repository",
                    ]
                ),
                DeepDiveDetail(
                    title: "Built-in Handlers",
                    body: "Four handler types cover common DevOps workflows. Each handler translates the agent's action request into the appropriate API call.",
                    bullets: [
                        "Azure handler: ARM deployments, resource management",
                        "ADO handler: Azure DevOps pipeline triggers, work item updates",
                        "GitHub handler: PR operations, issue management, workflow dispatch",
                        "HTTP handler: Generic webhook/API calls for custom integrations",
                    ]
                ),
                DeepDiveDetail(
                    title: "Audit Trail",
                    body: "Every action execution is persisted with full context: who requested it, what parameters were used, the result status, and timing. This creates a complete audit trail for compliance and debugging."
                ),
            ]

        case .escalationMcp:
            [
                DeepDiveDetail(
                    title: "MCP Server Injection",
                    body: "The escalation-mcp package is an MCP (Model Context Protocol) server that gets injected into every agent container at startup. It provides tools that let the agent communicate with the control plane — the daemon — without direct network access.",
                    bullets: [
                        "The SessionBridge interface links MCP tool calls to daemon internals",
                        "Pending requests are tracked asynchronously, allowing agents to block until a human responds",
                        "The server is configured via environment variables injected at container creation",
                    ]
                ),
                DeepDiveDetail(
                    title: "Available Escalation Tools",
                    body: "The MCP server exposes a focused set of tools for structured agent-human communication.",
                    bullets: [
                        "ask_human — Pause and wait for human input (blocks the agent)",
                        "ask_ai — Consult another AI model for a second opinion",
                        "report_blocker — Flag an issue that prevents progress",
                        "report_plan — Submit the implementation plan before starting work",
                        "report_progress — Report phase transitions during execution",
                        "validate_in_browser — Trigger Playwright browser validation",
                        "execute_action — Request a control-plane action (see Action Control Plane)",
                        "check_messages — Poll for pending human messages without blocking",
                    ]
                ),
            ]

        case .validationEngine:
            [
                DeepDiveDetail(
                    title: "Three-Stage Validation",
                    body: "After the agent completes its work, the daemon orchestrates a multi-stage validation pipeline. All three stages must pass before a session can be approved for merge.",
                    bullets: [
                        "Smoke Tests — Playwright scripts test the running application in a real browser",
                        "Build & Unit Tests — Standard test suite execution inside the container",
                        "AI Code Review — An AI model reviews the diff for correctness, style, and security issues",
                    ]
                ),
                DeepDiveDetail(
                    title: "Playwright Script Generation",
                    body: "The validator package generates Playwright test scripts dynamically based on the session's acceptance criteria and profile configuration. Scripts are injected into the container and executed by the daemon's validation engine. Results are parsed from Playwright's JSON output format."
                ),
                DeepDiveDetail(
                    title: "Review Gating",
                    body: "Validation results determine whether a session advances to 'validated' status. Failed validations trigger automatic retries (up to the configured max attempts). The human reviewer sees all validation results — pass or fail — alongside the code diff when deciding to approve or reject."
                ),
            ]

        case .runtimeArchitecture:
            [
                DeepDiveDetail(
                    title: "Pluggable Runtime Interface",
                    body: "Each runtime implements a common interface: start an agent, stream structured events, and handle termination. This lets Autopod support multiple AI providers with the same orchestration pipeline.",
                    bullets: [
                        "Runtime selection is per-session via the profile configuration",
                        "All runtimes emit the same AgentEvent union type",
                        "Stream parsers handle SSE/NDJSON formatting differences between providers",
                    ]
                ),
                DeepDiveDetail(
                    title: "Supported Runtimes",
                    body: "Three runtimes are currently implemented, each with dedicated stream parsers and comprehensive test coverage for edge cases.",
                    bullets: [
                        "Claude Runtime — Anthropic API with SSE streaming, full tool use support",
                        "Codex Runtime — OpenAI API with NDJSON streaming",
                        "Copilot Runtime — GitHub Copilot API integration",
                    ]
                ),
                DeepDiveDetail(
                    title: "Agent Event Types",
                    body: "All runtimes produce a unified event stream consumed by the event bus.",
                    codeSnippet: "status | toolUse | fileChange | escalation | plan | progress | error | complete"
                ),
            ]

        case .profileInjection:
            [
                DeepDiveDetail(
                    title: "Profile Configuration",
                    body: "Profiles are the unit of configuration in Autopod. They define everything needed to run a session: which stack to use, how to authenticate, what network access to allow, and what tools to inject.",
                    bullets: [
                        "Stack templates define the base image and toolchain (Node, .NET, Python, etc.)",
                        "Execution target: Docker (local) or ACI (Azure cloud)",
                        "Network policy per profile (allow-all, deny-all, restricted with allowlist)",
                        "Private registry configuration for ADO feeds (.npmrc / NuGet.config)",
                        "Profile inheritance — extend a base profile and override specific settings",
                    ]
                ),
                DeepDiveDetail(
                    title: "Skill & MCP Injection",
                    body: "Profiles can inject skills (documentation/instructions) and MCP servers into agent containers. The skill resolver fetches content from local files or GitHub repos. MCP servers are configured with their transport, command, and environment variables."
                ),
                DeepDiveDetail(
                    title: "System Instructions Generation",
                    body: "The system-instructions-generator builds the CLAUDE.md file that's placed inside each container. It combines the profile's skill content, injected sections (resolved by section-resolver), and standard instructions into a coherent document the agent uses as its operating manual."
                ),
            ]

        case .credentialSecurity:
            [
                DeepDiveDetail(
                    title: "Credential Encryption",
                    body: "All stored credentials (API keys, tokens, registry passwords) are encrypted at rest using AES-256. The encryption key is stored separately at ~/.autopod/secrets.key, isolating it from the database.",
                    bullets: [
                        "AES-256-GCM encryption via credentials-cipher.ts",
                        "Key file permissions restricted to the daemon user",
                        "Credentials are decrypted only when needed for container provisioning",
                    ]
                ),
                DeepDiveDetail(
                    title: "Session Token System",
                    body: "Short-lived HMAC-based tokens authenticate requests between the daemon and its components. Tokens are scoped to individual sessions and expire automatically, limiting the blast radius of any token compromise."
                ),
                DeepDiveDetail(
                    title: "PII Sanitization",
                    body: "Agent output passes through a sanitization pipeline before storage. The processor detects and quarantines PII patterns and potential prompt injection attempts, ensuring sensitive data doesn't leak into logs or the database.",
                    bullets: [
                        "Pattern-based detection for common PII formats (emails, SSNs, API keys)",
                        "Prompt injection pattern detection and neutralization",
                        "Quarantine system isolates flagged content for review",
                    ]
                ),
                DeepDiveDetail(
                    title: "Git PAT Stripping",
                    body: "When mounting git repositories into containers, personal access tokens are stripped from remote URLs. Agents interact with bare repos that have clean URLs, preventing credential leakage through agent logs or tool output."
                ),
            ]
        }
    }
}

// MARK: - Preview

#Preview("Deep Dive") {
    FeatureDeepDiveView()
        .frame(width: 800, height: 700)
}
