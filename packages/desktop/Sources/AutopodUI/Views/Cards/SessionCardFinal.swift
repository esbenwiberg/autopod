import SwiftUI

/// Two-state session card: compact for fleet scanning, expanded for taking action.
/// Mix of A (status dots, shadows) and B (accent stripe, density).
public struct SessionCardFinal: View {
    public let session: Session
    public var actions: SessionActions
    public init(session: Session, actions: SessionActions = .preview) {
        self.session = session; self.actions = actions
    }

    @State private var isExpanded = false
    @State private var isHovered = false

    private var showExpandedByDefault: Bool { session.status.needsAttention }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Accent stripe
            session.status.color
                .frame(height: 2.5)
                .opacity(session.status.needsAttention ? 1 : 0.4)

            VStack(alignment: .leading, spacing: 0) {
                // Header — always visible, click to toggle
                compactContent
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.spring(duration: 0.25)) { isExpanded.toggle() } }

                // Expanded detail — slides in
                if isExpanded {
                    Divider().padding(.horizontal, 4)
                    expandedContent
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(12)
        }
        .frame(width: isExpanded ? 260 : 230)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(
                    color: .black.opacity(isHovered ? 0.12 : 0.05),
                    radius: isHovered ? 10 : 4,
                    y: isHovered ? 3 : 1
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    session.status.needsAttention
                        ? session.status.color.opacity(0.25)
                        : Color(nsColor: .separatorColor).opacity(0.5),
                    lineWidth: session.status.needsAttention ? 1 : 0.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .animation(.spring(duration: 0.25), value: isExpanded)
        .onHover { isHovered = $0 }
        .onAppear { isExpanded = showExpandedByDefault }
    }

    // MARK: - Compact (always visible)

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Top row: dot + branch + badge
            HStack(spacing: 7) {
                StatusDot(status: session.status)
                Text(session.branch)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                Spacer()
                if session.isWorkspace {
                    modeBadge
                }
                statusBadge
            }

            // Summary row — one line per state
            HStack {
                compactSummary
                Spacer()
                Text(session.duration)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var modeBadge: some View {
        Text("workspace")
            .font(.system(.caption2).weight(.medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(.teal.opacity(0.1))
            .foregroundStyle(.teal)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    @ViewBuilder
    private var compactSummary: some View {
        if session.isWorkspace {
            workspaceCompactSummary
        } else {
            workerCompactSummary
        }
    }

    @ViewBuilder
    private var workspaceCompactSummary: some View {
        switch session.status {
        case .running:
            Label("Interactive", systemImage: "terminal")
                .font(.caption)
                .foregroundStyle(.teal)
        case .complete:
            Label("Branch pushed", systemImage: "arrow.up.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        default:
            Text(session.status.label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var workerCompactSummary: some View {
        switch session.status {
        case .running:
            if let phase = session.phase {
                HStack(spacing: 6) {
                    ProgressView(value: Double(phase.current), total: Double(phase.total))
                        .tint(.green)
                        .frame(width: 50)
                    Text(phase.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        case .awaitingInput:
            Label("Needs your input", systemImage: "bubble.left.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        case .validated:
            Label("Ready for review", systemImage: "checkmark.seal")
                .font(.caption)
                .foregroundStyle(.green)
        case .failed:
            if let err = session.errorSummary {
                Text(err)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.red)
                    .lineLimit(1)
            }
        case .validating:
            HStack(spacing: 5) {
                ProgressView().scaleEffect(0.5)
                Text("Validating...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .queued:
            Text("Queue position \(session.queuePosition ?? 1)")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .provisioning:
            HStack(spacing: 5) {
                ProgressView().scaleEffect(0.5)
                Text("Setting up...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .merging:
            HStack(spacing: 5) {
                ProgressView().scaleEffect(0.5)
                Text("Creating PR...")
                    .font(.caption)
                    .foregroundStyle(.purple)
            }
        case .complete:
            if session.prUrl != nil {
                Label("Merged", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        default:
            Text(session.profileName)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var statusBadge: some View {
        Text(session.status.label)
            .font(.system(.caption2).weight(.medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(session.status.color.opacity(0.1))
            .foregroundStyle(session.status.color)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    // MARK: - Expanded detail

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Profile context
            HStack(spacing: 4) {
                Text(session.profileName)
                    .foregroundStyle(.secondary)
                if !session.isWorkspace {
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(session.model)
                        .foregroundStyle(.tertiary)
                }
            }
            .font(.caption2)
            .padding(.top, 8)

            // Base branch origin (workspace handoff)
            if let base = session.baseBranch {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.branch")
                        .font(.system(size: 9))
                        .foregroundStyle(.teal)
                    Text("from \(base)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.teal)
                }
            }

            // State-specific detail
            if session.isWorkspace {
                workspaceExpandedContent
            } else {
                expandedStateContent
            }

            // Acceptance criteria (compact)
            if let criteria = session.acceptanceCriteria, !criteria.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("AC (\(criteria.count))")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(Array(criteria.prefix(3).enumerated()), id: \.offset) { _, ac in
                        HStack(spacing: 4) {
                            Image(systemName: "square")
                                .font(.system(size: 8))
                                .foregroundStyle(.tertiary)
                            Text(ac)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    if criteria.count > 3 {
                        Text("+\(criteria.count - 3) more")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            // Diff stats
            if let diff = session.diffStats {
                HStack(spacing: 5) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                    Text("+\(diff.added)")
                        .foregroundStyle(.green)
                    Text("-\(diff.removed)")
                        .foregroundStyle(.red)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text("\(diff.files) files")
                        .foregroundStyle(.secondary)
                }
                .font(.system(.caption2, design: .monospaced))
            }
        }
    }

    @ViewBuilder
    private var workspaceExpandedContent: some View {
        switch session.status {
        case .running:
            VStack(alignment: .leading, spacing: 8) {
                if let activity = session.latestActivity {
                    Text(activity)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button {
                } label: {
                    Label("Attach Terminal", systemImage: "terminal")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.teal)

                Button {
                } label: {
                    Label("Launch Worker", systemImage: "arrow.right.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Create a worker session starting from this workspace's branch")
            }
        case .complete:
            VStack(alignment: .leading, spacing: 8) {
                Label("Branch pushed — ready for worker", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                } label: {
                    Label("Launch Worker", systemImage: "arrow.right.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.blue)
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var expandedStateContent: some View {
        switch session.status {
        case .running:
            VStack(alignment: .leading, spacing: 8) {
                if let activity = session.latestActivity {
                    Text(activity)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button {
                    Task { await actions.nudge(session.id) }
                } label: {
                    Label("Nudge", systemImage: "hand.tap")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Send a gentle reminder to the agent to refocus")
            }

        case .awaitingInput:
            VStack(alignment: .leading, spacing: 8) {
                if let q = session.escalationQuestion {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "quote.opening")
                            .font(.system(size: 10))
                            .foregroundStyle(.orange.opacity(0.5))
                            .padding(.top, 2)
                        Text(q)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                HStack(spacing: 6) {
                    Button {
                        // Reply opens detail panel — tap the card to select it
                    } label: {
                        Label("Reply", systemImage: "arrowshape.turn.up.left")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.orange)
                    Button {
                        Task { await actions.nudge(session.id) }
                    } label: {
                        Label("Nudge", systemImage: "hand.tap")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

        case .validated:
            VStack(alignment: .leading, spacing: 8) {
                if let checks = session.validationChecks {
                    HStack(spacing: 10) {
                        checkItem("Smoke", passed: checks.smoke)
                        checkItem("Tests", passed: checks.tests)
                        checkItem("Review", passed: checks.review)
                    }
                }
                HStack(spacing: 6) {
                    Button {
                        Task { await actions.approve(session.id) }
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.green)
                    Button("Reject") {
                        Task { await actions.reject(session.id, nil) }
                    }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                if session.containerUrl != nil {
                    Button {
                        if let url = session.containerUrl { NSWorkspace.shared.open(url) }
                    } label: {
                        Label("Open App", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                if let err = session.errorSummary {
                    HStack(alignment: .top, spacing: 5) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.system(size: 11))
                        Text(err)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.red)
                            .lineLimit(3)
                    }
                }
                if let a = session.attempts {
                    Text("Attempt \(a.current) of \(a.max)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Button {
                        Task { await actions.retry(session.id) }
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.red)
                    Button("Logs") {}
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }

        case .validating:
            VStack(alignment: .leading, spacing: 6) {
                if let a = session.attempts {
                    Text("Attempt \(a.current) of \(a.max)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if session.containerUrl != nil {
                    Button {
                        if let url = session.containerUrl { NSWorkspace.shared.open(url) }
                    } label: {
                        Label("Open App", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

        case .complete:
            if let url = session.prUrl {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Label("PR #\(url.lastPathComponent)", systemImage: "arrow.up.right.square.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

        default:
            EmptyView()
        }
    }

    private func checkItem(_ label: String, passed: Bool) -> some View {
        VStack(spacing: 3) {
            Image(systemName: passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(passed ? .green : .red)
                .font(.system(size: 14))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Previews

#Preview("Compact — fleet scan") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(session: MockData.running)
        SessionCardFinal(session: MockData.runningEarly)
        SessionCardFinal(session: MockData.queued)
        SessionCardFinal(session: MockData.provisioning)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Auto-expanded — needs attention") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(session: MockData.awaitingInput)
        SessionCardFinal(session: MockData.validated)
        SessionCardFinal(session: MockData.failed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Workspace pods") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(session: MockData.workspaceActive)
        SessionCardFinal(session: MockData.workspaceComplete)
        SessionCardFinal(session: MockData.workerFromWorkspace)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Mixed fleet") {
    let sessions: [Session] = MockData.all
    ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), spacing: 10)], alignment: .leading, spacing: 10) {
            ForEach(sessions) { session in
                SessionCardFinal(session: session)
            }
        }
        .padding(24)
    }
    .frame(width: 900, height: 700)
    .background(Color(nsColor: .windowBackgroundColor))
}
