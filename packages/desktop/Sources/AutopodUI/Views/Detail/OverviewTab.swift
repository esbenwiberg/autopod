import SwiftUI

/// Overview tab — session metadata, escalation, plan progress, activity feed.
struct OverviewTab: View {
    let session: Session
    let events: [AgentEvent]
    var actions: SessionActions = .preview
    var pendingMemories: [MemoryEntry] = []
    var onApproveMemory: (String) -> Void = { _ in }
    var onRejectMemory: (String) -> Void = { _ in }

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

                // Progress
                if let phase = session.phase {
                    progressSection(phase)
                }

                // Pending memory suggestions
                if !pendingMemories.isEmpty {
                    memorySuggestionsSection
                }

                // Profile metadata row
                profileMetadataRow

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

                // Error / review required
                if session.status == .failed || session.status == .reviewRequired {
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

            if let options = session.escalationOptions, !options.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(options, id: \.self) { option in
                        Button {
                            replyText = option
                            sendReply()
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "circle")
                                    .font(.system(size: 11))
                                Text(option)
                                    .frame(maxWidth: .infinity, alignment: .leading)
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

    // MARK: - Progress

    private func progressSection(_ phase: PhaseProgress) -> some View {
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

    // MARK: - Memory suggestions

    private var memorySuggestionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "brain")
                    .foregroundStyle(.purple)
                Text("Memory Suggestions")
                    .font(.system(.subheadline).weight(.semibold))
                Text("\(pendingMemories.count)")
                    .font(.caption2)
                    .foregroundStyle(.purple)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.purple.opacity(0.1), in: Capsule())
            }
            ForEach(pendingMemories) { entry in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 4) {
                        Text(entry.path)
                            .font(.system(.caption, design: .monospaced).weight(.medium))
                        Spacer()
                        Text(entry.scope.label)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                    Text(entry.content.prefix(120) + (entry.content.count > 120 ? "…" : ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    HStack(spacing: 8) {
                        Button { onApproveMemory(entry.id) } label: {
                            Label("Approve", systemImage: "checkmark")
                                .font(.caption)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                        .tint(.green)
                        Button { onRejectMemory(entry.id) } label: {
                            Label("Reject", systemImage: "xmark")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .tint(.red)
                    }
                }
                .padding(10)
                .background(Color.purple.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.purple.opacity(0.1), lineWidth: 1))
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Profile metadata

    private var profileMetadataRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "person.text.rectangle")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(session.profileName)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            if let version = session.profileSnapshot?.version {
                Text("v\(version)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }
            Spacer()
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(session.branch)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
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
                validationRow("Smoke Tests", status: checks.smoke, icon: "flame")
                validationRow("Test Suite", status: checks.tests, icon: "testtube.2")
                validationRow("Code Review", status: checks.review, icon: "eye")
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func validationRow(_ label: String, status: Bool?, icon: String) -> some View {
        let color: Color = switch status {
        case true: .green
        case false: .red
        case nil: .gray
        }
        let iconName: String = switch status {
        case true: "checkmark"
        case false: "xmark"
        case nil: "minus"
        }
        return VStack(spacing: 6) {
            ZStack {
                Circle()
                    .fill(color.opacity(0.1))
                    .frame(width: 36, height: 36)
                Image(systemName: iconName)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(color)
            }
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Error

    private var errorSection: some View {
        let isReview = session.status == .reviewRequired
        let accentColor: Color = isReview ? .orange : .red
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(accentColor)
                Text(isReview ? "Review Required" : "Error")
                    .font(.system(.subheadline).weight(.semibold))
            }
            if isReview {
                Text("Validation attempts exhausted — a human should decide whether to extend or fix manually.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let err = session.errorSummary {
                Text(err)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(accentColor)
            }
            if let a = session.attempts {
                Text("Attempt \(a.current) of \(a.max)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .background(accentColor.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(accentColor.opacity(0.15), lineWidth: 1)
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
        let overviewEvents = Array(events.filter { $0.type.isOverviewWorthy }.suffix(6))
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Recent Activity")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                Text("\(events.count) events")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(overviewEvents) { event in
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
                    if event.id != overviewEvents.last?.id {
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
