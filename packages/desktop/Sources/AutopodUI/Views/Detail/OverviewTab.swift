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
                    if session.escalationType == "action_approval" {
                        actionApprovalCard(question)
                    } else {
                        escalationCard(question)
                    }
                }

                // Progress / plan
                if let phase = session.phase {
                    planSection(phase)
                }

                // Acceptance criteria (compact — full list in Validation tab)
                if let criteria = session.acceptanceCriteria, !criteria.isEmpty {
                    acSummary(criteria)
                }

                // Metrics row
                metricsRow

                // Commit activity (running/paused or any session with commits)
                if session.commitCount > 0 || session.status == .running || session.status == .paused {
                    commitSection
                }

                // Validation summary (if available)
                if let checks = session.validationChecks {
                    validationSummary(checks)
                }

                // Error (if failed)
                if session.status == .failed {
                    errorSection
                }

                // Session chain
                if session.linkedSessionId != nil {
                    chainSection
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

    // MARK: - Action approval

    private func actionApprovalCard(_ question: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "shield.checkered")
                    .foregroundStyle(.purple)
                Text("Action requires approval")
                    .font(.system(.subheadline).weight(.semibold))
            }

            Text(question)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Button {
                    replyText = "approved"
                    sendReply()
                } label: {
                    Label("Approve", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)

                Button {
                    replyText = "rejected"
                    sendReply()
                } label: {
                    Label("Reject", systemImage: "xmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }
        }
        .padding(14)
        .background(Color.purple.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.purple.opacity(0.2), lineWidth: 1)
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

    // MARK: - Acceptance criteria (compact)

    private func acSummary(_ criteria: [String]) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checklist")
                .foregroundStyle(.blue)
            Text("\(criteria.count) acceptance criteria")
                .font(.subheadline)
            Spacer()
            if let source = session.acFrom {
                Text(source)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Text("See Validation tab")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Metrics

    private var metricsRow: some View {
        let metrics: [(icon: String, value: String, label: String, color: Color)] = {
            var items: [(String, String, String, Color)] = [
                ("clock", session.duration, "Duration", .primary),
            ]
            if let diff = session.diffStats {
                items.append(("doc.text", "\(diff.files)", "Files", .primary))
                items.append(("plus", "\(diff.added)", "Added", .green))
                items.append(("minus", "\(diff.removed)", "Removed", .red))
            }
            items.append(("wrench", "\(events.filter { $0.type == .toolUse }.count)", "Tool calls", .primary))
            if session.inputTokens > 0 || session.costUsd > 0 || session.status == .running || session.status == .paused {
                items.append(("arrow.up.circle", formatTokens(session.inputTokens), "In tokens", session.inputTokens > 0 ? .primary : .secondary))
                items.append(("arrow.down.circle", formatTokens(session.outputTokens), "Out tokens", session.outputTokens > 0 ? .primary : .secondary))
                items.append(("dollarsign.circle", String(format: "$%.3f", session.costUsd), "Cost", session.costUsd > 0 ? .primary : .secondary))
            }
            return items
        }()

        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                metricItem(icon: metric.icon, value: metric.value, label: metric.label, color: metric.color)
            }
        }
    }

    private func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return "\(count / 1_000)K" }
        return "\(count)"
    }

    private func metricItem(icon: String, value: String, label: String, color: Color = .primary) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                Text(value)
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(color)
            }
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .padding(.horizontal, 8)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Commits

    private var commitSection: some View {
        let elapsed = Date().timeIntervalSince(session.startedAt)
        let elapsedMins = elapsed / 60
        let pace: String? = elapsedMins > 0 && session.commitCount > 0
            ? String(format: "%.1f/hr", Double(session.commitCount) / elapsedMins * 60)
            : nil
        let isStale = elapsedMins >= 30 && session.commitCount == 0
            && (session.status == .running || session.status == .paused)

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundStyle(isStale ? .yellow : .secondary)
                Text("Commits")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                if let pace {
                    Text(pace)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            // Dot timeline — up to 12 dots
            let maxDots = 12
            let filled = min(session.commitCount, maxDots)
            HStack(spacing: 3) {
                ForEach(0..<maxDots, id: \.self) { i in
                    Circle()
                        .fill(i < filled ? Color.green : Color(nsColor: .separatorColor))
                        .frame(width: 8, height: 8)
                }
                if session.commitCount > maxDots {
                    Text("+\(session.commitCount - maxDots)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(session.commitCount) commit\(session.commitCount == 1 ? "" : "s")")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(session.commitCount > 0 ? .primary : .secondary)
            }

            if isStale {
                Label("No commits yet — agent may be stuck", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.yellow)
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(isStale ? Color.yellow.opacity(0.3) : Color.clear, lineWidth: 1)
        )
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

    // MARK: - Session chain

    private var chainSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "link")
                    .foregroundStyle(.purple)
                Text("Session Chain")
                    .font(.system(.subheadline).weight(.semibold))
            }

            if let linked = session.linkedSessionId {
                VStack(alignment: .leading, spacing: 0) {
                    if session.isWorkspace {
                        // This workspace fixes a worker
                        chainNode(
                            id: linked,
                            label: "Worker",
                            detail: "failed — this workspace provides fixes",
                            icon: "gearshape",
                            color: .red,
                            isCurrent: false
                        )
                        chainConnector()
                        chainNode(
                            id: session.id,
                            label: "Fix (workspace)",
                            detail: session.status.label,
                            icon: "wrench.and.screwdriver",
                            color: .blue,
                            isCurrent: true
                        )
                        chainConnector()
                        chainNode(
                            id: nil,
                            label: "Revalidation",
                            detail: "triggers on push or workspace exit",
                            icon: "checkmark.arrow.trianglehead.counterclockwise",
                            color: .secondary,
                            isCurrent: false
                        )
                    } else {
                        // This worker was spawned from a workspace
                        chainNode(
                            id: linked,
                            label: "Workspace",
                            detail: "planning / preparation",
                            icon: "terminal",
                            color: .secondary,
                            isCurrent: false
                        )
                        chainConnector()
                        chainNode(
                            id: session.id,
                            label: "Worker",
                            detail: session.status.label,
                            icon: "gearshape",
                            color: session.status.color,
                            isCurrent: true
                        )
                    }
                }
                .padding(10)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func chainNode(
        id: String?,
        label: String,
        detail: String,
        icon: String,
        color: Color,
        isCurrent: Bool
    ) -> some View {
        HStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(isCurrent ? color.opacity(0.2) : color.opacity(0.1))
                    .frame(width: 22, height: 22)
                Image(systemName: icon)
                    .font(.system(size: 10))
                    .foregroundStyle(color)
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if let id {
                        Text(id)
                            .font(.system(.caption, design: .monospaced).weight(.semibold))
                    }
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    private func chainConnector() -> some View {
        HStack {
            Rectangle()
                .fill(Color.secondary.opacity(0.3))
                .frame(width: 1, height: 16)
                .padding(.leading, 10)
            Spacer()
        }
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
