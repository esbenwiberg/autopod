import SwiftUI

/// High-level overview of Autopod capabilities — visual feature cards with key highlights.
public struct FeatureOverviewView: View {
    @State private var hoveredFeature: String?
    @State private var selectedFeature: FeatureCategory?

    public init() {}

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
                .stroke(isHovered ? feature.color.opacity(0.35) : .clear, lineWidth: 1.5)
        )
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .onHover { hovering in hoveredFeature = hovering ? feature.id : nil }
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

enum FeatureCategory: String, CaseIterable, Identifiable {
    case sessionOrchestration
    case containerSecurity
    case multiRuntime
    case actionControlPlane
    case escalationSystem
    case validationPipeline
    case profileManagement
    case realTimeMonitoring

    var id: String { rawValue }

    var title: String {
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

    var icon: String {
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

    var color: Color {
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

    var summary: String {
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

    var highlights: [String] {
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
}

// MARK: - Preview

#Preview("Feature Overview") {
    FeatureOverviewView()
        .frame(width: 900, height: 800)
}
