import SwiftUI

/// Overview tab — session metadata, escalation, plan progress, activity feed.
struct OverviewTab: View {
    let session: Session
    let events: [AgentEvent]
    var actions: SessionActions = .preview

    @State private var replyText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Escalation card (if pending)
                if session.status == .awaitingInput, let question = session.escalationQuestion {
                    escalationCard(question)
                }

                // Progress / plan
                if let phase = session.phase {
                    planSection(phase)
                }

                // Acceptance criteria
                if let criteria = session.acceptanceCriteria, !criteria.isEmpty {
                    acceptanceCriteriaSection(criteria)
                }

                // Metrics row
                metricsRow

                // Validation summary (if available)
                if let checks = session.validationChecks {
                    validationSummary(checks)
                }

                // Error (if failed)
                if session.status == .failed {
                    errorSection
                }

                // Recent activity
                activityFeed
            }
            .padding(20)
        }
    }

    // MARK: - Escalation

    private func escalationCard(_ question: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.and.exclamationmark.bubble.right.fill")
                    .foregroundStyle(.orange)
                Text("Agent needs input")
                    .font(.system(.subheadline).weight(.semibold))
            }

            Text(question)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                TextField("Type your reply...", text: $replyText)
                    .textFieldStyle(.plain)
                    .padding(8)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .onSubmit { sendReply() }

                Button {
                    sendReply()
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .disabled(replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .background(Color.orange.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.orange.opacity(0.2), lineWidth: 1)
        )
    }

    // MARK: - Plan / progress

    private func planSection(_ phase: PhaseProgress) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Progress")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                Text("\(phase.current) of \(phase.total)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: Double(phase.current), total: Double(phase.total))
                .tint(.green)

            // Phase markers
            HStack(spacing: 0) {
                ForEach(1...phase.total, id: \.self) { step in
                    HStack(spacing: 0) {
                        Circle()
                            .fill(step <= phase.current ? Color.green : Color(nsColor: .separatorColor))
                            .frame(width: 6, height: 6)
                        if step < phase.total {
                            Rectangle()
                                .fill(step < phase.current ? Color.green.opacity(0.3) : Color(nsColor: .separatorColor).opacity(0.3))
                                .frame(height: 1)
                        }
                    }
                }
            }

            Text(phase.description)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Acceptance criteria

    private func acceptanceCriteriaSection(_ criteria: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("Acceptance Criteria")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                if let source = session.acFrom {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.text")
                            .font(.system(size: 9))
                        Text(source)
                            .font(.system(.caption2, design: .monospaced))
                    }
                    .foregroundStyle(.tertiary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(criteria.enumerated()), id: \.offset) { _, criterion in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "square")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .padding(.top, 1)
                        Text(criterion)
                            .font(.callout)
                    }
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Metrics

    private var metricsRow: some View {
        HStack(spacing: 0) {
            metricItem(
                icon: "clock",
                value: session.duration,
                label: "Duration"
            )
            Divider().frame(height: 30)
            if let diff = session.diffStats {
                metricItem(
                    icon: "doc.text",
                    value: "\(diff.files)",
                    label: "Files"
                )
                Divider().frame(height: 30)
                metricItem(
                    icon: "plus",
                    value: "\(diff.added)",
                    label: "Added",
                    color: .green
                )
                Divider().frame(height: 30)
                metricItem(
                    icon: "minus",
                    value: "\(diff.removed)",
                    label: "Removed",
                    color: .red
                )
            }
            Divider().frame(height: 30)
            metricItem(
                icon: "wrench",
                value: "\(events.filter { $0.type == .toolUse }.count)",
                label: "Tool calls"
            )
        }
        .padding(.vertical, 10)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func metricItem(icon: String, value: String, label: String, color: Color = .primary) -> some View {
        VStack(spacing: 3) {
            HStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    .foregroundStyle(color)
            }
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Validation summary

    private func validationSummary(_ checks: ValidationChecks) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Validation")
                .font(.system(.subheadline).weight(.semibold))
            HStack(spacing: 16) {
                validationRow("Smoke Tests", passed: checks.smoke, icon: "flame")
                validationRow("Test Suite", passed: checks.tests, icon: "testtube.2")
                validationRow("Code Review", passed: checks.review, icon: "eye")
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func validationRow(_ label: String, passed: Bool, icon: String) -> some View {
        VStack(spacing: 6) {
            ZStack {
                Circle()
                    .fill(passed ? Color.green.opacity(0.1) : Color.red.opacity(0.1))
                    .frame(width: 36, height: 36)
                Image(systemName: passed ? "checkmark" : "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(passed ? .green : .red)
            }
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Error

    private var errorSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                Text("Error")
                    .font(.system(.subheadline).weight(.semibold))
            }
            if let err = session.errorSummary {
                Text(err)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.red)
            }
            if let a = session.attempts {
                Text("Attempt \(a.current) of \(a.max)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .background(Color.red.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.red.opacity(0.15), lineWidth: 1)
        )
    }

    // MARK: - Activity feed

    private var activityFeed: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Recent Activity")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                Text("\(events.count) events")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(events.suffix(6)) { event in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: event.type.icon)
                            .font(.system(size: 9))
                            .foregroundStyle(event.type.color)
                            .frame(width: 14)
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(event.summary)
                                .font(.caption)
                                .lineLimit(1)
                            Text(event.timeString)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding(.vertical, 5)
                    .padding(.horizontal, 8)
                    if event.id != events.suffix(6).last?.id {
                        Divider().padding(.leading, 28)
                    }
                }
            }
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    // MARK: - Reply

    private func sendReply() {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        replyText = ""
        Task { await actions.reply(session.id, text) }
    }
}

// MARK: - Previews

#Preview("Overview — running") {
    OverviewTab(session: MockData.running, events: MockEvents.running)
        .frame(width: 550, height: 600)
}

#Preview("Overview — awaiting input") {
    OverviewTab(session: MockData.awaitingInput, events: MockEvents.awaitingInput)
        .frame(width: 550, height: 500)
}

#Preview("Overview — validated") {
    OverviewTab(session: MockData.validated, events: MockEvents.running)
        .frame(width: 550, height: 500)
}

#Preview("Overview — failed") {
    OverviewTab(session: MockData.failed, events: MockEvents.failed)
        .frame(width: 550, height: 500)
}

#Preview("Overview — worker with ACs") {
    OverviewTab(session: MockData.workerFromWorkspace, events: MockEvents.running)
        .frame(width: 550, height: 600)
}
