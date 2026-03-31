import SwiftUI

/// Variant C — Bold card with status banner header. OrbStack-inspired.
public struct SessionCardC: View {
    public let session: Session
    public init(session: Session) { self.session = session }
    @State private var isHovered = false

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Status banner
            HStack {
                StatusDot(status: session.status)
                Text(session.status.label.uppercased())
                    .font(.system(.caption2, design: .default).weight(.bold))
                    .tracking(0.5)
                Spacer()
                Text(session.duration)
                    .font(.system(.caption2, design: .monospaced))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(session.status.color.gradient)

            VStack(alignment: .leading, spacing: 12) {
                // Identity
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.branch)
                        .font(.system(.body, design: .monospaced).weight(.semibold))
                        .lineLimit(1)
                    Text(session.profileName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // State content
                stateContent

                // Bottom bar
                HStack(spacing: 8) {
                    if let diff = session.diffStats {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.text")
                                .font(.system(size: 9))
                                .foregroundStyle(.tertiary)
                            Text("\(diff.files)")
                                .foregroundStyle(.secondary)
                            Text("+\(diff.added)")
                                .foregroundStyle(.green)
                            Text("-\(diff.removed)")
                                .foregroundStyle(.red)
                        }
                        .font(.system(.caption2, design: .monospaced))
                    }
                    Spacer()
                    Text(session.model)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(14)
        }
        .frame(width: 250)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .shadow(color: .black.opacity(isHovered ? 0.15 : 0.06), radius: isHovered ? 10 : 5, y: isHovered ? 3 : 1)
        .scaleEffect(isHovered ? 1.02 : 1.0)
        .animation(.spring(duration: 0.2), value: isHovered)
        .onHover { isHovered = $0 }
    }

    // MARK: - State content

    @ViewBuilder
    private var stateContent: some View {
        switch session.status {
        case .running:
            if let phase = session.phase {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(phase.description)
                            .font(.caption.weight(.medium))
                        Spacer()
                        Text("\(phase.current)/\(phase.total)")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 3)
                                .fill(.quaternary)
                            RoundedRectangle(cornerRadius: 3)
                                .fill(.green.gradient)
                                .frame(width: geo.size.width * Double(phase.current) / Double(phase.total))
                        }
                    }
                    .frame(height: 6)
                    if let activity = session.latestActivity {
                        Text(activity)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
        case .awaitingInput:
            VStack(alignment: .leading, spacing: 8) {
                if let q = session.escalationQuestion {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "bubble.left.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(.orange.opacity(0.7))
                        Text(q)
                            .font(.callout)
                            .lineLimit(3)
                    }
                }
                Button {
                } label: {
                    Label("Reply", systemImage: "arrowshape.turn.up.left.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.orange)
            }
        case .validated:
            VStack(alignment: .leading, spacing: 8) {
                if let checks = session.validationChecks {
                    HStack(spacing: 12) {
                        checkItem("Smoke", passed: checks.smoke)
                        checkItem("Tests", passed: checks.tests)
                        checkItem("Review", passed: checks.review)
                    }
                }
                HStack(spacing: 6) {
                    Button {
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.green)
                    Button("Reject") {}
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        case .failed:
            VStack(alignment: .leading, spacing: 6) {
                if let err = session.errorSummary {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.system(size: 12))
                        Text(err)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.red)
                            .lineLimit(2)
                    }
                }
                if let a = session.attempts {
                    Text("Attempt \(a.current) of \(a.max)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Button {
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.red)
                    Button("View Logs") {}
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        case .validating:
            HStack(spacing: 8) {
                ProgressView().scaleEffect(0.6)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Running validation...")
                        .font(.caption.weight(.medium))
                    if let a = session.attempts {
                        Text("Attempt \(a.current) of \(a.max)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
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
        case .queued:
            HStack(spacing: 6) {
                Image(systemName: "hourglass")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 11))
                Text("Position \(session.queuePosition ?? 1) in queue")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .provisioning:
            HStack(spacing: 8) {
                ProgressView().scaleEffect(0.6)
                Text("Setting up container...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        default:
            if let reason = session.errorSummary {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func checkItem(_ label: String, passed: Bool) -> some View {
        VStack(spacing: 3) {
            Image(systemName: passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(passed ? .green : .red)
                .font(.system(size: 16))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Previews

#Preview("C — Needs Attention") {
    HStack(alignment: .top, spacing: 14) {
        SessionCardC(session: MockData.awaitingInput)
        SessionCardC(session: MockData.validated)
        SessionCardC(session: MockData.failed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("C — Running") {
    HStack(alignment: .top, spacing: 14) {
        SessionCardC(session: MockData.running)
        SessionCardC(session: MockData.runningEarly)
        SessionCardC(session: MockData.validating)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("C — Other") {
    HStack(alignment: .top, spacing: 14) {
        SessionCardC(session: MockData.queued)
        SessionCardC(session: MockData.provisioning)
        SessionCardC(session: MockData.complete)
        SessionCardC(session: MockData.killed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}
