import SwiftUI

/// Variant B — Compact card with colored top accent stripe. Linear-inspired.
public struct SessionCardB: View {
    public let session: Session
    public init(session: Session) { self.session = session }
    @State private var isHovered = false

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Accent stripe
            session.status.color
                .frame(height: 3)
                .opacity(session.status.needsAttention ? 1 : 0.5)

            VStack(alignment: .leading, spacing: 8) {
                // Header row
                HStack(spacing: 6) {
                    Text(session.branch)
                        .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                        .lineLimit(1)
                    Spacer()
                    statusBadge
                }

                // Profile + model
                HStack(spacing: 4) {
                    Text(session.profileName)
                        .foregroundStyle(.secondary)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(session.model)
                        .foregroundStyle(.tertiary)
                }
                .font(.caption2)

                // State content
                stateContent

                // Footer
                HStack {
                    diffStatsRow
                    Spacer()
                    Text(session.duration)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .frame(width: 240)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .shadow(color: .black.opacity(isHovered ? 0.1 : 0.04), radius: isHovered ? 8 : 3, y: 1)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .onHover { isHovered = $0 }
    }

    // MARK: - Status badge

    private var statusBadge: some View {
        Text(session.status.label)
            .font(.system(.caption2).weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(session.status.color.opacity(0.12))
            .foregroundStyle(session.status.color)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    // MARK: - State content

    @ViewBuilder
    private var stateContent: some View {
        switch session.status {
        case .running:
            if let phase = session.phase {
                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: Double(phase.current), total: Double(phase.total))
                        .tint(.green)
                    Text(phase.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        case .awaitingInput:
            if let q = session.escalationQuestion {
                VStack(alignment: .leading, spacing: 6) {
                    Text(q)
                        .font(.caption)
                        .lineLimit(2)
                        .foregroundStyle(.primary)
                    Button("Reply") {}
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                        .tint(.orange)
                }
            }
        case .validated:
            if let checks = session.validationChecks {
                HStack(spacing: 8) {
                    checkPill("Smoke", passed: checks.smoke)
                    checkPill("Tests", passed: checks.tests)
                    checkPill("Review", passed: checks.review)
                }
                HStack(spacing: 4) {
                    Button("Approve") {}
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                        .tint(.green)
                    Button("Reject") {}
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                }
            }
        case .failed:
            VStack(alignment: .leading, spacing: 4) {
                if let err = session.errorSummary {
                    Text(err)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.red)
                        .lineLimit(1)
                }
                if let a = session.attempts {
                    Text("Attempt \(a.current)/\(a.max)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        case .validating:
            HStack(spacing: 6) {
                ProgressView().scaleEffect(0.5)
                Text("Validating...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .complete:
            if let url = session.prUrl {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Label("PR #\(url.lastPathComponent)", systemImage: "arrow.up.right.square")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.blue)
            }
        case .queued:
            Text("Position \(session.queuePosition ?? 1) in queue")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .provisioning:
            HStack(spacing: 6) {
                ProgressView().scaleEffect(0.5)
                Text("Provisioning...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        default:
            EmptyView()
        }
    }

    // MARK: - Helpers

    private func checkPill(_ label: String, passed: Bool) -> some View {
        HStack(spacing: 3) {
            Image(systemName: passed ? "checkmark" : "xmark")
                .font(.system(size: 8, weight: .bold))
            Text(label)
        }
        .font(.system(.caption2))
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(passed ? Color.green.opacity(0.1) : Color.red.opacity(0.1))
        .foregroundStyle(passed ? .green : .red)
        .clipShape(RoundedRectangle(cornerRadius: 3))
    }

    private var diffStatsRow: some View {
        Group {
            if let diff = session.diffStats {
                HStack(spacing: 4) {
                    Text("+\(diff.added)")
                        .foregroundStyle(.green)
                    Text("-\(diff.removed)")
                        .foregroundStyle(.red)
                    Text("\(diff.files)f")
                        .foregroundStyle(.secondary)
                }
                .font(.system(.caption2, design: .monospaced))
            }
        }
    }
}

// MARK: - Previews

#Preview("B — Needs Attention") {
    HStack(alignment: .top, spacing: 12) {
        SessionCardB(session: MockData.awaitingInput)
        SessionCardB(session: MockData.validated)
        SessionCardB(session: MockData.failed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("B — Running") {
    HStack(alignment: .top, spacing: 12) {
        SessionCardB(session: MockData.running)
        SessionCardB(session: MockData.runningEarly)
        SessionCardB(session: MockData.validating)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("B — Other") {
    HStack(alignment: .top, spacing: 12) {
        SessionCardB(session: MockData.queued)
        SessionCardB(session: MockData.provisioning)
        SessionCardB(session: MockData.complete)
        SessionCardB(session: MockData.killed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}
