import SwiftUI

/// Controls card information density in the fleet grid.
public enum CardDensity: String, CaseIterable {
    case compact
    case detailed

    public var label: String {
        switch self {
        case .compact: "Compact"
        case .detailed: "Detailed"
        }
    }

    public var icon: String {
        switch self {
        case .compact: "rectangle.grid.2x2"
        case .detailed: "square.grid.2x2"
        }
    }
}

/// Two-state session card: compact for fleet scanning, detailed for at-a-glance actions.
/// Mix of A (status dots, shadows) and B (accent stripe, density).
public struct SessionCardFinal: View {
    public let session: Session
    public var actions: SessionActions
    public var density: CardDensity

    public init(session: Session, actions: SessionActions = .preview, density: CardDensity = .detailed) {
        self.session = session; self.actions = actions; self.density = density
    }

    @State private var isHovered = false

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Accent stripe
            session.status.color
                .frame(height: 2)
                .opacity(session.status.needsAttention ? 0.9 : 0.25)

            compactContent
                .padding(12)

            if density == .detailed {
                expandedContent
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: density == .detailed ? .infinity : nil, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(
                    color: .black.opacity(isHovered ? 0.08 : 0.03),
                    radius: isHovered ? 8 : 3,
                    y: isHovered ? 2 : 1
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    isHovered
                        ? Color.accentColor.opacity(0.4)
                        : session.status.needsAttention
                            ? session.status.color.opacity(0.35)
                            : Color.white.opacity(0.15),
                    lineWidth: 1.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .onHover { isHovered = $0 }
        .alert("Reject session", isPresented: $showRejectFeedback) {
            TextField("What needs to change?", text: $rejectFeedbackText)
            Button("Reject", role: .destructive) {
                let feedback = rejectFeedbackText.isEmpty ? nil : rejectFeedbackText
                rejectFeedbackText = ""
                Task { await actions.reject(session.id, feedback) }
            }
            Button("Cancel", role: .cancel) {
                rejectFeedbackText = ""
            }
        } message: {
            Text("Tell the agent what to fix. Leave blank for a generic rejection.")
        }
        .alert("Nudge agent", isPresented: $showNudgeInput) {
            TextField("Message for the agent…", text: $nudgeInputText)
            Button("Send") {
                let message = nudgeInputText.isEmpty ? "Please refocus on the task." : nudgeInputText
                nudgeInputText = ""
                Task { await actions.nudge(session.id, message) }
            }
            Button("Cancel", role: .cancel) {
                nudgeInputText = ""
            }
        } message: {
            Text("Send a message to redirect the agent. Leave blank for a default nudge.")
        }
        .alert("Resume session", isPresented: $showResumeInput) {
            TextField("Message for the agent…", text: $resumeInputText)
            Button("Resume") {
                let message = resumeInputText.isEmpty ? "Continue where you left off." : resumeInputText
                resumeInputText = ""
                Task { await actions.reply(session.id, message) }
            }
            Button("Cancel", role: .cancel) {
                resumeInputText = ""
            }
        } message: {
            Text("Send a message to resume the agent. Leave blank for a default resume.")
        }
    }

    // MARK: - Compact (always visible)

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Top row: dot + ID + badge
            HStack(spacing: 7) {
                StatusDot(status: session.status)
                Text(session.id)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .foregroundStyle(session.status == .complete ? .green : session.status == .killed ? .red.opacity(0.6) : .primary)
                    .lineLimit(1)
                Spacer()
                modeBadge
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
        let label: String = switch session.outputMode {
        case .pr:        "PR"
        case .artifact:  "ART"
        case .workspace: "WS"
        }
        return Text(label)
            .font(.system(.caption2).weight(.medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.08))
            .foregroundStyle(.secondary)
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
                .foregroundStyle(.secondary)
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
            if session.validationChecks?.allPassed != false {
                Label("Ready for review", systemImage: "checkmark.seal")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Label("Validation failed — needs action", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
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
                    .foregroundStyle(.secondary)
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
            .background(session.status.color.opacity(0.08))
            .foregroundStyle(session.status.color.opacity(0.85))
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
                        .foregroundStyle(.secondary)
                    Text("from \(base)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            // Linked session indicator
            if let linked = session.linkedSessionId {
                HStack(spacing: 4) {
                    Image(systemName: "link")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    Text(session.isWorkspace ? "fixes \(linked)" : "← \(linked)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            // State-specific detail
            if session.isWorkspace {
                workspaceExpandedContent
            } else {
                expandedStateContent
            }

            // Diff stats
            if let diff = session.diffStats {
                HStack(spacing: 5) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 8))
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
                .monospacedDigit()
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
                    actions.attachTerminal(session.id)
                } label: {
                    Label("Attach Terminal", systemImage: "terminal")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                if session.linkedSessionId == nil {
                    Button {
                    } label: {
                        Label("Launch Worker", systemImage: "arrow.right.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Create a worker session starting from this workspace's branch")
                }

                if session.linkedSessionId != nil {
                    Button {
                        Task { await actions.revalidate(session.linkedSessionId!) }
                    } label: {
                        Label("Revalidate Worker", systemImage: "checkmark.arrow.trianglehead.counterclockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Pull latest and re-run validation on the linked worker session")
                }
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
                    showNudgeInput = true
                } label: {
                    Label("Nudge", systemImage: "hand.tap")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Send a message to the agent to refocus")
                Button {
                    Task { await actions.pause(session.id) }
                } label: {
                    Label("Pause", systemImage: "pause.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.yellow)
                .help("Suspend the agent — container stays alive for quick resume")
            }

        case .paused:
            VStack(alignment: .leading, spacing: 8) {
                Text("Session paused — agent suspended, container alive")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    showResumeInput = true
                } label: {
                    Label("Resume", systemImage: "play.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.green)
                .help("Resume the agent with an optional message")
            }

        case .awaitingInput:
            VStack(alignment: .leading, spacing: 8) {
                if let q = session.escalationQuestion {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: session.escalationType == "action_approval" ? "shield.checkered" : "quote.opening")
                            .font(.system(size: 10))
                            .foregroundStyle(session.escalationType == "action_approval" ? .purple.opacity(0.7) : .orange.opacity(0.5))
                            .padding(.top, 2)
                        Text(q)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if session.escalationType == "action_approval" {
                    HStack(spacing: 6) {
                        Button {
                            Task { await actions.reply(session.id, "approved") }
                        } label: {
                            Label("Approve", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .tint(.green)

                        Button {
                            Task { await actions.reply(session.id, "rejected") }
                        } label: {
                            Label("Reject", systemImage: "xmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .tint(.red)
                    }
                } else {
                    Button {
                        showOptionsPicker = true
                    } label: {
                        Label("Reply", systemImage: "arrowshape.turn.up.left")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.orange)
                    .sheet(isPresented: $showOptionsPicker) {
                        replySheet
                    }
                }
            }

        case .validated:
            VStack(alignment: .leading, spacing: 8) {
                if let checks = session.validationChecks {
                    HStack(spacing: 10) {
                        checkItem("Smoke", status: checks.smoke)
                        checkItem("Tests", status: checks.tests)
                        checkItem("Review", status: checks.review)
                    }
                }
                if session.validationChecks?.allPassed != false {
                    // All checks passed — approve is primary
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
                            showRejectFeedback = true
                        }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                } else {
                    // Validation failed — rework/fix actions are primary
                    HStack(spacing: 6) {
                        Button {
                            Task { await actions.rework(session.id) }
                        } label: {
                            Label("Rework", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .tint(.orange)
                        Button {
                            Task { await actions.fixManually(session.id) }
                        } label: {
                            Label("Fix", systemImage: "wrench.and.screwdriver")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    Button {
                        Task { await actions.approve(session.id) }
                    } label: {
                        Label("Approve Anyway", systemImage: "checkmark")
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
                        Task { await actions.rework(session.id) }
                    } label: {
                        Label("Rework", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.red)
                    Button {
                        Task { await actions.fixManually(session.id) }
                    } label: {
                        Label("Fix", systemImage: "wrench.and.screwdriver")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    Button("Logs") {}
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                deleteButton
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
            VStack(alignment: .leading, spacing: 6) {
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
                deleteButton
            }

        case .killed:
            deleteButton

        default:
            EmptyView()
        }
    }

    @State private var replyInputText = ""
    @State private var showOptionsPicker = false
    @State private var showNudgeInput = false
    @State private var nudgeInputText = ""
    @State private var showResumeInput = false
    @State private var resumeInputText = ""
    @State private var showRejectFeedback = false
    @State private var rejectFeedbackText = ""
    @State private var showDeleteConfirmation = false

    private var replySheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(session.escalationQuestion ?? "Agent needs input")
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)

            if let options = session.escalationOptions, !options.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(options, id: \.self) { option in
                        Button {
                            showOptionsPicker = false
                            Task { await actions.reply(session.id, option) }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "circle")
                                    .font(.system(size: 11))
                                Text(option)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .multilineTextAlignment(.leading)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                        }
                        .buttonStyle(.bordered)
                        .tint(.orange)
                    }
                }

                Divider()

                HStack(spacing: 4) {
                    Image(systemName: "pencil")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Or type a custom reply:")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 8) {
                TextField("Type your reply…", text: $replyInputText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        guard !replyInputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                        let message = replyInputText
                        replyInputText = ""
                        showOptionsPicker = false
                        Task { await actions.reply(session.id, message) }
                    }

                Button {
                    let message = replyInputText
                    replyInputText = ""
                    showOptionsPicker = false
                    Task { await actions.reply(session.id, message) }
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .disabled(replyInputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) {
                    replyInputText = ""
                    showOptionsPicker = false
                }
                .controlSize(.small)
            }
        }
        .padding(20)
        .frame(minWidth: 400)
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            showDeleteConfirmation = true
        } label: {
            Label("Delete", systemImage: "trash")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .confirmationDialog("Delete session \(session.id)?", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) {
                Task { await actions.delete(session.id) }
            }
        } message: {
            Text("This will permanently remove the session record.")
        }
    }

    private func checkItem(_ label: String, status: Bool?) -> some View {
        VStack(spacing: 3) {
            Image(systemName: status == true ? "checkmark.circle.fill"
                  : status == false ? "xmark.circle.fill"
                  : "minus.circle")
                .foregroundStyle(status == true ? .green : status == false ? .red : .gray)
                .font(.system(size: 14))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Previews

#Preview("Compact") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(session: MockData.running, density: .compact)
        SessionCardFinal(session: MockData.awaitingInput, density: .compact)
        SessionCardFinal(session: MockData.validated, density: .compact)
        SessionCardFinal(session: MockData.failed, density: .compact)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Detailed") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(session: MockData.running, density: .detailed)
        SessionCardFinal(session: MockData.awaitingInput, density: .detailed)
        SessionCardFinal(session: MockData.validated, density: .detailed)
        SessionCardFinal(session: MockData.failed, density: .detailed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Workspace pods — detailed") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(session: MockData.workspaceActive, density: .detailed)
        SessionCardFinal(session: MockData.workspaceComplete, density: .detailed)
        SessionCardFinal(session: MockData.workerFromWorkspace, density: .detailed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Mixed fleet — detailed") {
    let sessions: [Session] = MockData.all
    ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 10)], alignment: .leading, spacing: 10) {
            ForEach(sessions) { session in
                SessionCardFinal(session: session, density: .detailed)
            }
        }
        .padding(24)
    }
    .frame(width: 900, height: 700)
    .background(Color(nsColor: .windowBackgroundColor))
}
