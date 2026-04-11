import SwiftUI

/// Detail pane shown when a feature card is selected on the Overview page.
/// Presents What / Why / How sections with inline diagrams for the selected feature.
public struct FeatureDetailPanelView: View {
    public let feature: FeatureCategory
    public var onSelectRelated: ((FeatureCategory) -> Void)?

    public init(feature: FeatureCategory, onSelectRelated: ((FeatureCategory) -> Void)? = nil) {
        self.feature = feature
        self.onSelectRelated = onSelectRelated
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle()
                .fill(feature.color.opacity(0.4))
                .frame(height: 2)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    sectionCard("What", content: feature.what)
                    sectionCard("Why", content: feature.why)
                    howCard
                    diagramSection
                    if !feature.keyFiles.isEmpty {
                        keyFilesSection
                    }
                    if !feature.relatedFeatures.isEmpty {
                        relatedSection
                    }
                }
                .padding(20)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: feature.icon)
                    .font(.system(size: 18))
                    .foregroundStyle(feature.color)
                    .frame(width: 34, height: 34)
                    .background(feature.color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text(feature.title)
                        .font(.headline)
                    Text(feature.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            FeatureFlowLayout(spacing: 6) {
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
        .padding(20)
    }

    // MARK: - Section card

    private func sectionCard(_ title: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(feature.color)
                    .frame(width: 3, height: 16)
                Text(title)
                    .font(.system(.subheadline).weight(.bold))
            }
            Text(content)
                .font(.system(.caption))
                .foregroundStyle(.secondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - How card (with bullets)

    private var howCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(feature.color)
                    .frame(width: 3, height: 16)
                Text("How")
                    .font(.system(.subheadline).weight(.bold))
            }
            Text(feature.how)
                .font(.system(.caption))
                .foregroundStyle(.secondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            if !feature.howBullets.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(feature.howBullets, id: \.self) { bullet in
                        HStack(alignment: .top, spacing: 7) {
                            Circle()
                                .fill(feature.color.opacity(0.5))
                                .frame(width: 5, height: 5)
                                .padding(.top, 5)
                            Text(bullet)
                                .font(.system(.caption))
                                .foregroundStyle(.secondary)
                                .lineSpacing(2)
                        }
                    }
                }
                .padding(.leading, 2)
                .padding(.top, 4)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Diagram section

    @ViewBuilder
    private var diagramSection: some View {
        switch feature {
        case .containerSecurity:
            diagramCard("Defense Layers") { containerSecurityDiagram }
        case .validationPipeline:
            diagramCard("Validation Phases") { validationPhaseDiagram }
        case .escalationSystem:
            diagramCard("Tool Categories") { escalationToolDiagram }
        case .actionControlPlane:
            diagramCard("Request Flow") { actionFlowDiagram }
        case .sessionOrchestration:
            diagramCard("State Flow") { sessionStateDiagram }
        case .profileManagement:
            diagramCard("Injection Pipeline") { profileInjectionDiagram }
        case .multiRuntime:
            diagramCard("Streaming Protocol") { runtimeStreamDiagram }
        case .realTimeMonitoring:
            diagramCard("Event Flow") { monitoringEventDiagram }
        case .memoryStore:
            diagramCard("Scope Hierarchy") { memoryStoreDiagram }
        }
    }

    private func diagramCard<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "diagram")
                    .font(.system(size: 10))
                    .foregroundStyle(feature.color)
                Text(title)
                    .font(.system(.caption).weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Container security diagram

    private var containerSecurityDiagram: some View {
        VStack(spacing: 6) {
            defenseLayer("Network", "iptables OUTPUT chain, ICC disabled, autopod-net bridge", "network", .red)
            defenseLayer("Capability", "Only NET_ADMIN (for iptables), no other caps", "shield.lefthalf.filled", .orange)
            defenseLayer("User", "Non-root autopod:1000, restricted mounts", "person.fill", .yellow)
            defenseLayer("Git", "Bare repos, PATs in-memory on host only, stripped URLs", "lock.doc", .green)
            defenseLayer("Content", "PII redaction, prompt injection detection, quarantine", "doc.text.magnifyingglass", .blue)
        }
    }

    private func defenseLayer(_ title: String, _ desc: String, _ icon: String, _ color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(color)
                .frame(width: 22, height: 22)
                .background(color.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 5))
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(.caption2).weight(.bold))
                Text(desc)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(color.opacity(0.03))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Validation phase diagram

    private var validationPhaseDiagram: some View {
        let phases: [(String, String, Color)] = [
            ("hammer", "Build", .blue),
            ("testtube.2", "Test", .cyan),
            ("heart.text.clipboard", "Health", .teal),
            ("globe", "Smoke", .green),
            ("checklist", "AC", .mint),
            ("brain.head.profile", "AI Review", .purple),
            ("checkmark.seal", "Overall", .green),
        ]
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(phases.enumerated()), id: \.offset) { index, phase in
                    HStack(spacing: 0) {
                        VStack(spacing: 3) {
                            Image(systemName: phase.0)
                                .font(.system(size: 10))
                                .foregroundStyle(phase.2)
                                .frame(width: 22, height: 22)
                                .background(phase.2.opacity(0.1))
                                .clipShape(Circle())
                            Text(phase.1)
                                .font(.system(size: 9).weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        if index < phases.count - 1 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 7))
                                .foregroundStyle(.quaternary)
                                .padding(.horizontal, 2)
                                .padding(.bottom, 14)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Escalation tool diagram

    private var escalationToolDiagram: some View {
        VStack(spacing: 8) {
            toolCategory("Blocking", .orange, [
                ("person.fill.questionmark", "ask_human"),
                ("flag.fill", "report_blocker"),
                ("globe", "validate_in_browser"),
            ])
            toolCategory("Non-blocking", .blue, [
                ("brain", "ask_ai"),
                ("doc.text", "report_plan"),
                ("chart.bar.fill", "report_progress"),
                ("envelope", "check_messages"),
            ])
            toolCategory("Dynamic", .purple, [
                ("bolt.fill", "execute_action"),
                ("arrow.clockwise", "trigger_revalidation"),
            ])
        }
    }

    private func toolCategory(_ title: String, _ color: Color, _ tools: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 9).weight(.bold))
                .foregroundStyle(color)
                .textCase(.uppercase)
                .padding(.leading, 4)
            FeatureFlowLayout(spacing: 4) {
                ForEach(tools, id: \.1) { icon, name in
                    HStack(spacing: 3) {
                        Image(systemName: icon)
                            .font(.system(size: 8))
                        Text(name)
                            .font(.system(size: 9, design: .monospaced))
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(color.opacity(0.06))
                    .foregroundStyle(color.opacity(0.8))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                }
            }
        }
    }

    // MARK: - Action flow diagram

    private var actionFlowDiagram: some View {
        let steps: [(String, String, Color)] = [
            ("arrow.right.circle", "Request", .blue),
            ("shield.checkered", "Validate", .orange),
            ("bolt.fill", "Execute", .purple),
            ("eye.trianglebadge.exclamationmark", "Sanitize", .red),
            ("doc.text", "Audit", .green),
        ]
        return VStack(spacing: 6) {
            HStack(spacing: 0) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    HStack(spacing: 0) {
                        VStack(spacing: 3) {
                            Image(systemName: step.0)
                                .font(.system(size: 10))
                                .foregroundStyle(step.2)
                                .frame(width: 22, height: 22)
                                .background(step.2.opacity(0.1))
                                .clipShape(Circle())
                            Text(step.1)
                                .font(.system(size: 9).weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        if index < steps.count - 1 {
                            Image(systemName: "arrow.right")
                                .font(.system(size: 7))
                                .foregroundStyle(.quaternary)
                                .padding(.horizontal, 3)
                                .padding(.bottom, 14)
                        }
                    }
                }
            }
            Text("PII redaction + prompt injection detection on every response")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
        }
    }

    // MARK: - Session state diagram

    private var sessionStateDiagram: some View {
        let mainFlow: [(String, String, Color)] = [
            ("tray.full", "Queued", .gray),
            ("shippingbox", "Provision", .blue),
            ("play.fill", "Running", .blue),
            ("checkmark.shield", "Validate", .cyan),
            ("person.fill.checkmark", "Review", .orange),
            ("arrow.triangle.merge", "Merge", .purple),
            ("checkmark.circle", "Complete", .green),
        ]
        return VStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(Array(mainFlow.enumerated()), id: \.offset) { index, step in
                        HStack(spacing: 0) {
                            VStack(spacing: 3) {
                                Image(systemName: step.0)
                                    .font(.system(size: 10))
                                    .foregroundStyle(step.2)
                                    .frame(width: 22, height: 22)
                                    .background(step.2.opacity(0.1))
                                    .clipShape(Circle())
                                Text(step.1)
                                    .font(.system(size: 9).weight(.medium))
                                    .foregroundStyle(.secondary)
                            }
                            if index < mainFlow.count - 1 {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 7))
                                    .foregroundStyle(.quaternary)
                                    .padding(.horizontal, 2)
                                    .padding(.bottom, 14)
                            }
                        }
                    }
                }
            }
            HStack(spacing: 12) {
                stateNote("pause.fill", "Paused", .yellow)
                stateNote("questionmark.circle", "Awaiting Input", .orange)
                stateNote("xmark.circle", "Failed → Retry", .red)
                stateNote("bolt.slash.fill", "Kill → Killed", .gray)
            }
            .font(.system(size: 9))
        }
    }

    private func stateNote(_ icon: String, _ label: String, _ color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 8))
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Profile injection diagram

    private var profileInjectionDiagram: some View {
        VStack(spacing: 6) {
            injectionRow("doc.text.fill", "Skills", "GitHub repos / local files → /commands/", .indigo)
            injectionRow("server.rack", "MCP Servers", "Proxied through daemon, auth injected", .purple)
            injectionRow("doc.richtext", "CLAUDE.md Sections", "Priority-sorted, PII-sanitized, dynamic fetch", .blue)
            injectionRow("shippingbox", "Registry Configs", ".npmrc / NuGet.Config generated + validated", .green)
            injectionRow("key.fill", "Credentials", "AES-256-GCM encrypted, OAuth token refresh", .orange)
        }
    }

    private func injectionRow(_ icon: String, _ title: String, _ desc: String, _ color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(color)
                .frame(width: 22, height: 22)
                .background(color.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 5))
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(.caption2).weight(.bold))
                Text(desc)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
    }

    // MARK: - Runtime stream diagram

    private var runtimeStreamDiagram: some View {
        VStack(spacing: 6) {
            runtimeRow("Claude", "NDJSON (stream-json)", "Session persist + resume", .blue)
            runtimeRow("Codex", "JSONL (--json)", "Fresh spawn per resume", .cyan)
            runtimeRow("Copilot", "Plain text lines", "Re-spawn with correction", .gray)
        }
    }

    private func runtimeRow(_ name: String, _ format: String, _ resume: String, _ color: Color) -> some View {
        HStack(spacing: 8) {
            Text(name)
                .font(.system(.caption2).weight(.bold))
                .foregroundStyle(color)
                .frame(width: 50, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(format)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text(resume)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.03))
        .clipShape(RoundedRectangle(cornerRadius: 5))
    }

    // MARK: - Monitoring event diagram

    private var monitoringEventDiagram: some View {
        VStack(spacing: 6) {
            let events: [(String, String, Color)] = [
                ("plus.circle", "session.created", .green),
                ("arrow.triangle.swap", "status_changed", .blue),
                ("cpu", "agent_activity", .cyan),
                ("checkmark.shield", "validation.*", .purple),
                ("bubble.left.fill", "escalation.*", .orange),
                ("flag.checkered", "session.completed", .green),
            ]
            FeatureFlowLayout(spacing: 4) {
                ForEach(events, id: \.1) { icon, name, color in
                    HStack(spacing: 3) {
                        Image(systemName: icon)
                            .font(.system(size: 8))
                            .foregroundStyle(color)
                        Text(name)
                            .font(.system(size: 9, design: .monospaced))
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(color.opacity(0.06))
                    .foregroundStyle(color.opacity(0.8))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                }
            }
            Text("30-day retention · event replay · PII sanitized before broadcast")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
        }
    }

    // MARK: - Memory store diagram

    private var memoryStoreDiagram: some View {
        VStack(spacing: 6) {
            let scopes: [(String, String, String, Color)] = [
                ("globe", "Global", "user.md · persists across all sessions", .mint),
                ("person.fill", "Profile", "profile.md · shared across profile sessions", .teal),
                ("doc.fill", "Session", "session.md · ephemeral, injected at start", .cyan),
            ]
            ForEach(scopes, id: \.1) { icon, scope, detail, color in
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .font(.system(size: 9))
                        .foregroundStyle(color)
                        .frame(width: 14)
                    Text(scope)
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .foregroundStyle(color)
                        .frame(width: 48, alignment: .leading)
                    Text(detail)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(color.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            Text("suggest → approve → inject into CLAUDE.md")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
        }
    }

    // MARK: - Key files

    private var keyFilesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Key Files")
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)

            FeatureFlowLayout(spacing: 6) {
                ForEach(feature.keyFiles, id: \.self) { file in
                    Text(file)
                        .font(.system(.caption2, design: .monospaced))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(feature.color.opacity(0.06))
                        .foregroundStyle(feature.color.opacity(0.8))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                }
            }
        }
    }

    // MARK: - Related features

    private var relatedSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Related")
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)

            FeatureFlowLayout(spacing: 6) {
                ForEach(feature.relatedFeatures) { related in
                    Button {
                        onSelectRelated?(related)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: related.icon)
                                .font(.system(size: 9))
                            Text(related.title)
                                .font(.caption2)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(related.color.opacity(0.08))
                        .foregroundStyle(related.color)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

// MARK: - Flow layout for file tags

struct FeatureFlowLayout: Layout {
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

// MARK: - Previews

#Preview("Feature Detail — Container Security") {
    FeatureDetailPanelView(feature: .containerSecurity)
        .frame(width: 380, height: 800)
}

#Preview("Feature Detail — Validation Pipeline") {
    FeatureDetailPanelView(feature: .validationPipeline)
        .frame(width: 380, height: 800)
}

#Preview("Feature Detail — Escalation System") {
    FeatureDetailPanelView(feature: .escalationSystem)
        .frame(width: 380, height: 800)
}

#Preview("Feature Detail — Action Control Plane") {
    FeatureDetailPanelView(feature: .actionControlPlane)
        .frame(width: 380, height: 800)
}
