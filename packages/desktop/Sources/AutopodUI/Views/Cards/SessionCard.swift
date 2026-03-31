import SwiftUI

public struct SessionCard: View {
    public let session: Session
    public init(session: Session) { self.session = session }
    @State private var isHovered = false

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().padding(.vertical, 10)
            stateContent
            Spacer(minLength: 8)
            footer
        }
        .padding(14)
        .frame(width: 230)
        .frame(minHeight: 170)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(isHovered ? 0.14 : 0.07), radius: isHovered ? 12 : 6, y: isHovered ? 4 : 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(session.status.needsAttention ? session.status.color.opacity(0.3) : Color(nsColor: .separatorColor), lineWidth: session.status.needsAttention ? 1 : 0.5)
        )
        .scaleEffect(isHovered ? 1.015 : 1.0)
        .animation(.spring(duration: 0.2), value: isHovered)
        .onHover { isHovered = $0 }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(status: session.status)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.branch)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                Text(session.profileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - State content

    @ViewBuilder
    private var stateContent: some View {
        switch session.status {
        case .queued:
            queuedContent
        case .provisioning:
            provisioningContent
        case .running:
            runningContent
        case .awaitingInput:
            awaitingInputContent
        case .validating:
            validatingContent
        case .validated:
            validatedContent
        case .failed:
            failedContent
        case .approved, .merging:
            mergingContent
        case .complete:
            completeContent
        case .killing, .killed:
            killedContent
        }
    }

    // MARK: - Queued

    private var queuedContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Position \(session.queuePosition ?? 1) in queue", systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Provisioning

    private var provisioningContent: some View {
        HStack(spacing: 8) {
            ProgressView().scaleEffect(0.6)
            Text("Setting up container...")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Running

    private var runningContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let phase = session.phase {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(phase.description)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                        Text("\(phase.current)/\(phase.total)")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    ProgressView(value: Double(phase.current), total: Double(phase.total))
                        .tint(.green)
                }
            }
            if let activity = session.latestActivity {
                Text(activity)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            diffStatsRow
        }
    }

    // MARK: - Awaiting input

    private var awaitingInputContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let q = session.escalationQuestion {
                Text("\(q)")
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Reply") {}
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
        }
    }

    // MARK: - Validating

    private var validatingContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().scaleEffect(0.6)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Validating...")
                        .font(.caption.weight(.medium))
                    if let a = session.attempts {
                        Text("Attempt \(a.current) of \(a.max)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            diffStatsRow
            if session.containerUrl != nil {
                openAppButton
            }
        }
    }

    // MARK: - Validated

    private var validatedContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let checks = session.validationChecks {
                VStack(alignment: .leading, spacing: 3) {
                    checkRow("Smoke", passed: checks.smoke)
                    checkRow("Tests", passed: checks.tests)
                    checkRow("Review", passed: checks.review)
                }
            }
            diffStatsRow
            HStack(spacing: 6) {
                Button("Approve") {}
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.green)
                Button("Reject") {}
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                if session.containerUrl != nil {
                    openAppButton
                }
            }
        }
    }

    // MARK: - Failed

    private var failedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = session.errorSummary {
                Text(err)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
            if let a = session.attempts {
                Text("Attempt \(a.current) of \(a.max)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Button("Retry") {}
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.red)
                Button("Logs") {}
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }

    // MARK: - Merging

    private var mergingContent: some View {
        HStack(spacing: 8) {
            ProgressView().scaleEffect(0.6)
            Text("Creating PR...")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Complete

    private var completeContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let url = session.prUrl {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Label(url.lastPathComponent.isEmpty ? "View PR" : "PR #\(url.lastPathComponent)", systemImage: "arrow.up.right.square")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            diffStatsRow
        }
    }

    // MARK: - Killed

    private var killedContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let reason = session.errorSummary {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Reusable bits

    private var diffStatsRow: some View {
        Group {
            if let diff = session.diffStats {
                HStack(spacing: 6) {
                    Text("+\(diff.added)")
                        .foregroundStyle(.green)
                    Text("-\(diff.removed)")
                        .foregroundStyle(.red)
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text("\(diff.files) files")
                        .foregroundStyle(.secondary)
                }
                .font(.system(.caption2, design: .monospaced))
            }
        }
    }

    private var openAppButton: some View {
        Button {
            if let url = session.containerUrl { NSWorkspace.shared.open(url) }
        } label: {
            Label("Open App", systemImage: "safari")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private func checkRow(_ label: String, passed: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(passed ? .green : .red)
                .font(.system(size: 10))
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Text(session.model)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
            Spacer()
            Text(session.duration)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Previews

#Preview("Needs Attention") {
    HStack(alignment: .top, spacing: 12) {
        SessionCard(session: MockData.awaitingInput)
        SessionCard(session: MockData.validated)
        SessionCard(session: MockData.failed)
    }
    .padding(20)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Running") {
    HStack(alignment: .top, spacing: 12) {
        SessionCard(session: MockData.running)
        SessionCard(session: MockData.runningEarly)
        SessionCard(session: MockData.validating)
    }
    .padding(20)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Other states") {
    HStack(alignment: .top, spacing: 12) {
        SessionCard(session: MockData.queued)
        SessionCard(session: MockData.provisioning)
        SessionCard(session: MockData.merging)
        SessionCard(session: MockData.complete)
        SessionCard(session: MockData.killed)
    }
    .padding(20)
    .background(Color(nsColor: .windowBackgroundColor))
}
