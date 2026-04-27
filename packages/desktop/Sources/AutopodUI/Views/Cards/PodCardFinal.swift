import SwiftUI
import AutopodClient
import MarkdownUI

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

/// Two-state pod card: compact for fleet scanning, detailed for at-a-glance actions.
/// Mix of A (status dots, shadows) and B (accent stripe, density).
public struct SessionCardFinal: View {
    public let pod: Pod
    public var actions: PodActions
    public var density: CardDensity
    public var isSelected: Bool
    /// Called when the user picks "Spawn follow-up" from the card's context
    /// menu / footer button. Host (e.g. MainView) opens the SpawnDependentSheet.
    public var onSpawnFollowUp: ((Pod) -> Void)?
    /// Called when the user picks "Launch series from here" on an interactive
    /// pod. Host opens the CreateSeriesSheet with baseBranch pre-filled.
    public var onLaunchSeriesFromPod: ((Pod) -> Void)?
    /// Persisted quality score for this pod (nil for running pods or pods
    /// that completed before the recorder shipped). When set and pod is
    /// terminal, a small colored pill renders in the top row.
    public var qualityScore: PodQualityScore?

    public init(
        pod: Pod,
        actions: PodActions = .preview,
        density: CardDensity = .detailed,
        isSelected: Bool = false,
        onSpawnFollowUp: ((Pod) -> Void)? = nil,
        onLaunchSeriesFromPod: ((Pod) -> Void)? = nil,
        qualityScore: PodQualityScore? = nil
    ) {
        self.pod = pod; self.actions = actions; self.density = density; self.isSelected = isSelected
        self.onSpawnFollowUp = onSpawnFollowUp
        self.onLaunchSeriesFromPod = onLaunchSeriesFromPod
        self.qualityScore = qualityScore
    }

    @State private var isHovered = false

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Accent stripe
            pod.status.color
                .frame(height: 2)
                .opacity(isSelected ? 0.8 : (pod.status.needsAttention || pod.status == .complete) ? 0.9 : 0.25)

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
                    color: .black.opacity(isSelected ? 0.1 : isHovered ? 0.08 : 0.03),
                    radius: isSelected ? 10 : isHovered ? 8 : 3,
                    y: isSelected ? 3 : isHovered ? 2 : 1
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    isSelected
                        ? Color.accentColor.opacity(0.9)
                        : isHovered
                            ? Color.accentColor.opacity(0.4)
                            : (pod.status.needsAttention || pod.status == .complete)
                                ? pod.status.color.opacity(0.35)
                                : Color.white.opacity(0.15),
                    lineWidth: isSelected ? 2 : 1.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .animation(.easeOut(duration: 0.15), value: isSelected)
        .onHover { isHovered = $0 }
        .contextMenu {
            if let onSpawnFollowUp, !pod.isTerminal {
                Button {
                    onSpawnFollowUp(pod)
                } label: {
                    Label("Spawn follow-up pod", systemImage: "arrow.branch")
                }
            }
            if let onLaunchSeriesFromPod, pod.isWorkspace, pod.status == .complete {
                Button {
                    onLaunchSeriesFromPod(pod)
                } label: {
                    Label("Launch series from here", systemImage: "rectangle.3.group.fill")
                }
            }
        }
        .sheet(isPresented: $showRejectFeedback) { rejectFeedbackSheet }
        .sheet(isPresented: $showNudgeInput) { nudgeSheet }
        .alert("Resume pod", isPresented: $showResumeInput) {
            TextField("Message for the agent…", text: $resumeInputText)
            Button("Resume") {
                let message = resumeInputText.isEmpty ? "Continue where you left off." : resumeInputText
                resumeInputText = ""
                Task { await actions.reply(pod.id, message) }
            }
            Button("Cancel", role: .cancel) {
                resumeInputText = ""
            }
        } message: {
            Text("Send a message to resume the agent. Leave blank for a default resume.")
        }
        .alert("Launch Worker", isPresented: $showLaunchWorker) {
            TextField("What should the worker do?", text: $launchWorkerTask)
            Button("Launch") {
                let task = launchWorkerTask
                let workerProfile = actions.workerProfileForProfile(pod.profileName) ?? pod.profileName
                launchWorkerTask = ""
                Task {
                    _ = await actions.createPod(
                        workerProfile,
                        task,
                        nil,
                        PodConfigRequest(agentMode: "auto", output: "pr", validate: true, promotable: false),
                        pod.acceptanceCriteria,
                        pod.branch,
                        pod.acFrom,
                        nil,
                        nil
                    )
                }
            }
            .disabled(launchWorkerTask.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {
                launchWorkerTask = ""
            }
        } message: {
            Text("Describe the task for the worker. It will branch from \(pod.branch).")
        }
    }

    // MARK: - Compact (always visible)

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Top row: dot + ID + badge
            HStack(spacing: 7) {
                StatusDot(status: pod.status)
                Text(pod.id)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .foregroundStyle(pod.status == .complete ? .green : pod.status == .killed ? .red.opacity(0.6) : .primary)
                    .lineLimit(1)
                if pod.seriesId != nil {
                    seriesChip
                }
                Spacer()
                if let score = qualityScore, pod.isTerminal {
                    qualityPill(score)
                }
                modeBadge
                statusBadge
            }

            // Summary row — one line per state
            HStack {
                compactSummary
                Spacer()
                Text(pod.duration)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var seriesChip: some View {
        HStack(spacing: 3) {
            Image(systemName: "rectangle.3.group.fill")
                .font(.system(size: 9))
            Text(pod.seriesName ?? "series")
                .lineLimit(1)
        }
        .font(.system(.caption2).weight(.medium))
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(Color.accentColor.opacity(0.12))
        .foregroundStyle(Color.accentColor)
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private var modeBadge: some View {
        let outputShort: String = switch pod.pod.output {
        case .pr:       "PR"
        case .branch:   "BR"
        case .artifact: "ART"
        case .none:     "∅"
        }
        let label = pod.pod.agentMode == .interactive ? "INT·\(outputShort)" : outputShort
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
        if pod.isWorkspace {
            workspaceCompactSummary
        } else {
            workerCompactSummary
        }
    }

    @ViewBuilder
    private var workspaceCompactSummary: some View {
        switch pod.status {
        case .running:
            Label("Interactive", systemImage: "terminal")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .handoff:
            Label("Handing off to agent…", systemImage: "arrow.triangle.swap")
                .font(.caption)
                .foregroundStyle(.blue)
        case .complete:
            Label("Branch pushed", systemImage: "arrow.up.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        default:
            Text(pod.status.label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var workerCompactSummary: some View {
        switch pod.status {
        case .running:
            if let phase = pod.phase {
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
            if pod.validationChecks?.allPassed != false {
                Label("Ready for review", systemImage: "checkmark.seal")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Label("Validation failed — needs action", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        case .reviewRequired:
            Label("Needs human review", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        case .failed:
            if let err = pod.errorSummary {
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
            Text(
                !pod.dependsOnPodIds.isEmpty ? "Waiting for predecessor"
                : pod.queuePosition.map { "Queue position \($0)" } ?? "Queued"
            )
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
        case .mergePending:
            HStack(spacing: 5) {
                ProgressView().scaleEffect(0.5)
                Text("Waiting to merge…")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        case .complete:
            if pod.prUrl != nil {
                Label("Merged", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        default:
            Text(pod.profileName)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var statusBadge: some View {
        Text(pod.status.label)
            .font(.system(.caption2).weight(.medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(pod.status.color.opacity(0.08))
            .foregroundStyle(pod.status.color.opacity(0.85))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func qualityPill(_ score: PodQualityScore) -> some View {
        HStack(spacing: 3) {
            Circle()
                .fill(qualityColor(score.score))
                .frame(width: 6, height: 6)
            Text("\(score.score)")
                .font(.system(.caption2).weight(.semibold))
                .monospacedDigit()
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(qualityColor(score.score).opacity(0.1))
        .foregroundStyle(qualityColor(score.score).opacity(0.9))
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .help(
            "Quality score \(score.score)/100 · "
            + "\(score.runtime) · \(score.model ?? "?") · "
            + "read/edit \(String(format: "%.1f", score.readEditRatio)) · "
            + "blind edits \(score.editsWithoutPriorRead) · "
            + "interrupts \(score.userInterrupts)"
        )
    }

    private func qualityColor(_ score: Int) -> Color {
        switch score {
        case 80...: return .green
        case 60..<80: return .yellow
        default: return .red
        }
    }

    // MARK: - Expanded detail

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Profile context
            HStack(spacing: 4) {
                Text(pod.profileName)
                    .foregroundStyle(.secondary)
                if !pod.isWorkspace {
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(pod.model)
                        .foregroundStyle(.tertiary)
                }
            }
            .font(.caption2)
            .padding(.top, 8)

            // Base branch origin (workspace handoff)
            if let base = pod.baseBranch {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.branch")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    Text("from \(base)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            // Linked pod indicator
            if let linked = pod.linkedSessionId {
                HStack(spacing: 4) {
                    Image(systemName: "link")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    Text(pod.isWorkspace ? "fixes \(linked)" : "← \(linked)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            // State-specific detail
            if pod.isWorkspace {
                workspaceExpandedContent
            } else {
                expandedStateContent
            }

            // Diff stats
            if let diff = pod.diffStats {
                HStack(spacing: 5) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 8))
                        .foregroundStyle(.tertiary)
                    Text(verbatim: "+\(diff.added)")
                        .foregroundStyle(.green)
                    Text(verbatim: "-\(diff.removed)")
                        .foregroundStyle(.red)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(verbatim: "\(diff.files) files")
                        .foregroundStyle(.secondary)
                }
                .font(.system(.caption2, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var workspaceExpandedContent: some View {
        switch pod.status {
        case .running:
            VStack(alignment: .leading, spacing: 8) {
                if let activity = pod.latestActivity {
                    Text(activity)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button {
                    actions.attachTerminal(pod.id)
                } label: {
                    Label("Attach Terminal", systemImage: "terminal")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                if pod.linkedSessionId == nil {
                    Button {
                        showLaunchWorker = true
                    } label: {
                        Label("Launch Worker", systemImage: "arrow.right.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Create a worker pod starting from this workspace's branch")
                }

                if pod.linkedSessionId != nil {
                    Button {
                        Task { await actions.revalidate(pod.linkedSessionId!) }
                    } label: {
                        Label("Revalidate Worker", systemImage: "checkmark.arrow.trianglehead.counterclockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Pull latest and re-run validation on the linked worker pod")
                }
            }
        case .complete:
            VStack(alignment: .leading, spacing: 8) {
                Label("Branch pushed — ready for worker", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    showLaunchWorker = true
                } label: {
                    Label("Launch Worker", systemImage: "arrow.right.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.blue)

                if let onLaunchSeriesFromPod {
                    Button {
                        onLaunchSeriesFromPod(pod)
                    } label: {
                        Label("Launch Series", systemImage: "rectangle.3.group.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Launch a pod series stacked on this branch")
                }
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var expandedStateContent: some View {
        switch pod.status {
        case .running:
            VStack(alignment: .leading, spacing: 8) {
                if let activity = pod.latestActivity {
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
                    Task { await actions.pause(pod.id) }
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
                Text("Pod paused — agent suspended, container alive")
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
                if let q = pod.escalationQuestion {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: pod.escalationType == "action_approval" ? "shield.checkered" : "quote.opening")
                            .font(.system(size: 10))
                            .foregroundStyle(pod.escalationType == "action_approval" ? .purple.opacity(0.7) : .orange.opacity(0.5))
                            .padding(.top, 2)
                        Text(q)
                            .font(.callout)
                            .lineLimit(3)
                    }
                }
                if pod.escalationType == "action_approval" {
                    HStack(spacing: 6) {
                        Button {
                            Task { await actions.reply(pod.id, "approved") }
                        } label: {
                            Label("Approve", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .tint(.green)

                        Button {
                            Task { await actions.reply(pod.id, "rejected") }
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
                if let checks = pod.validationChecks {
                    HStack(spacing: 10) {
                        checkItem("Smoke", status: checks.smoke)
                        checkItem("Tests", status: checks.tests)
                        checkItem("Review", status: checks.review)
                    }
                }
                if pod.validationChecks?.allPassed != false {
                    // All checks passed — approve is primary
                    HStack(spacing: 6) {
                        Button {
                            Task { await actions.approve(pod.id) }
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
                            Task { await actions.rework(pod.id) }
                        } label: {
                            Label("Rework", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .tint(.orange)
                        Button {
                            Task { await actions.fixManually(pod.id) }
                        } label: {
                            Label("Fix", systemImage: "wrench.and.screwdriver")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    Button {
                        Task { await actions.approve(pod.id) }
                    } label: {
                        Label("Approve Anyway", systemImage: "checkmark")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                if pod.containerUrl != nil {
                    Button {
                        if let url = pod.containerUrl { NSWorkspace.shared.open(url) }
                    } label: {
                        Label("Open App", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

        case .reviewRequired:
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .font(.system(size: 11))
                    Text("Validation attempts exhausted — human review needed")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let a = pod.attempts {
                    Text("Attempt \(a.current) of \(a.max)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Button {
                        Task { await actions.extendAttempts(pod.id, 2) }
                    } label: {
                        Label("Extend Attempts", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.orange)
                    Button {
                        Task { await actions.fixManually(pod.id) }
                    } label: {
                        Label("Fix", systemImage: "wrench.and.screwdriver")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                Button {
                    Task { await actions.kill(pod.id) }
                } label: {
                    Label("Kill", systemImage: "xmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)
            }

        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                if let err = pod.errorSummary {
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
                if let a = pod.attempts {
                    Text("Attempt \(a.current) of \(a.max)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Button {
                        Task { await actions.rework(pod.id) }
                    } label: {
                        Label("Rework", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.red)
                    Button {
                        Task { await actions.fixManually(pod.id) }
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
                if let a = pod.attempts {
                    Text("Attempt \(a.current) of \(a.max)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if pod.containerUrl != nil {
                    Button {
                        if let url = pod.containerUrl { NSWorkspace.shared.open(url) }
                    } label: {
                        Label("Open App", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

        case .mergePending:
            VStack(alignment: .leading, spacing: 6) {
                if let activity = pod.latestActivity {
                    Text(activity)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let url = pod.prUrl {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label("View PR", systemImage: "arrow.up.right.square.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

        case .complete:
            VStack(alignment: .leading, spacing: 6) {
                if let url = pod.prUrl {
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
    @State private var showLaunchWorker = false
    @State private var launchWorkerTask = ""

    private var replySheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Markdown(pod.escalationQuestion ?? "Agent needs input")
                        .markdownTheme(.autopod)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if let options = pod.escalationOptions, !options.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(options, id: \.self) { option in
                                Button {
                                    showOptionsPicker = false
                                    Task { await actions.reply(pod.id, option) }
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
                }
                .padding(20)
                .padding(.bottom, 4)
            }

            Divider()

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    TextField("Type your reply…", text: $replyInputText)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            guard !replyInputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                            let message = replyInputText
                            replyInputText = ""
                            showOptionsPicker = false
                            Task { await actions.reply(pod.id, message) }
                        }

                    Button {
                        let message = replyInputText
                        replyInputText = ""
                        showOptionsPicker = false
                        Task { await actions.reply(pod.id, message) }
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
        }
        .frame(minWidth: 560, maxWidth: 760, minHeight: 200, maxHeight: 600)
    }

    private var nudgeSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Nudge agent")
                .font(.headline)
            Text("Send a message to redirect the agent. Leave blank for a default nudge.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextEditor(text: $nudgeInputText)
                .font(.body)
                .frame(minHeight: 80)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
            HStack {
                Button("Cancel") {
                    nudgeInputText = ""
                    showNudgeInput = false
                }
                Spacer()
                Button("Send") {
                    let message = nudgeInputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "Please refocus on the task."
                        : nudgeInputText
                    nudgeInputText = ""
                    showNudgeInput = false
                    Task { await actions.nudge(pod.id, message) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
    }

    private var rejectFeedbackSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Reject pod")
                .font(.headline)
            Text("Tell the agent what to fix. Leave blank for a generic rejection.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextEditor(text: $rejectFeedbackText)
                .font(.body)
                .frame(minHeight: 80)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
            HStack {
                Button("Cancel") {
                    rejectFeedbackText = ""
                    showRejectFeedback = false
                }
                Spacer()
                Button("Reject") {
                    let feedback = rejectFeedbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? nil
                        : rejectFeedbackText
                    rejectFeedbackText = ""
                    showRejectFeedback = false
                    Task { await actions.reject(pod.id, feedback) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
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
        .confirmationDialog("Delete pod \(pod.id)?", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) {
                Task { await actions.delete(pod.id) }
            }
        } message: {
            Text("This will permanently remove the pod record.")
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
        SessionCardFinal(pod: MockData.running, density: .compact)
        SessionCardFinal(pod: MockData.awaitingInput, density: .compact)
        SessionCardFinal(pod: MockData.validated, density: .compact)
        SessionCardFinal(pod: MockData.failed, density: .compact)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Detailed") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(pod: MockData.running, density: .detailed)
        SessionCardFinal(pod: MockData.awaitingInput, density: .detailed)
        SessionCardFinal(pod: MockData.validated, density: .detailed)
        SessionCardFinal(pod: MockData.failed, density: .detailed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Workspace pods — detailed") {
    HStack(alignment: .top, spacing: 10) {
        SessionCardFinal(pod: MockData.workspaceActive, density: .detailed)
        SessionCardFinal(pod: MockData.workspaceComplete, density: .detailed)
        SessionCardFinal(pod: MockData.workerFromWorkspace, density: .detailed)
    }
    .padding(24)
    .background(Color(nsColor: .windowBackgroundColor))
}

#Preview("Mixed fleet — detailed") {
    let pods: [Pod] = MockData.all
    ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 10)], alignment: .leading, spacing: 10) {
            ForEach(pods) { pod in
                SessionCardFinal(pod: pod, density: .detailed)
            }
        }
        .padding(24)
    }
    .frame(width: 900, height: 700)
    .background(Color(nsColor: .windowBackgroundColor))
}
