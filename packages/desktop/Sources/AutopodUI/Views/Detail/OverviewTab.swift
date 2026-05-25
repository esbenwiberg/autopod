import AppKit
import AutopodClient
import MarkdownUI
import SwiftUI

/// Overview tab — pod metadata, escalation, plan progress, activity feed.
struct OverviewTab: View {
    let pod: Pod
    let events: [AgentEvent]
    var actions: PodActions = .preview
    var pendingMemories: [MemoryEntry] = []
    var onApproveMemory: (String) -> Void = { _ in }
    var onRejectMemory: (String) -> Void = { _ in }
    /// Optional closure for fetching session-quality signals. When nil
    /// (previews, tests without daemon), the Quality column shows an empty state.
    var loadQuality: ((String) async throws -> PodQualitySignals)? = nil
    /// Optional closure for fetching preview server status. When nil, the
    /// Preview card is static (shows last cached status or nil). Polled every 5 s.
    var loadPreviewStatus: ((String) async throws -> PreviewStatus)? = nil

    @State private var replyText = ""
    @State private var infrastructureExpanded = false
    @State private var quality: PodQualitySignals? = nil
    @State private var poller = PreviewPoller()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                overviewStatusStrip

                if pod.worktreeCompromised {
                    WorktreeCompromisedBanner()
                }

                if pod.status == .awaitingInput, let question = pod.escalationQuestion {
                    if pod.escalationType == "action_approval" {
                        actionApprovalCard(question)
                    } else {
                        escalationCard(question)
                    }
                }

                if pod.status == .reviewRequired {
                    reviewRequiredSection
                }

                if let phase = pod.phase {
                    progressSection(phase)
                }

                if !pendingMemories.isEmpty {
                    memorySuggestionsSection
                }

                overviewSnapshotGrid

                if pod.hasWebUi {
                    compactPreviewCard
                }

                if let artifactsPath = pod.artifactsPath, !artifactsPath.isEmpty {
                    artifactsSection(artifactsPath)
                }

                if !pod.requireSidecars.isEmpty
                    || !pod.sidecarContainerIds.isEmpty
                    || !pod.testRunBranches.isEmpty
                {
                    infrastructureSection
                }

                if pod.commitCount > 0 || pod.status == .running || pod.status == .paused {
                    commitSection
                }

                if let checks = pod.validationChecks {
                    validationSummary(checks)
                }

                if pod.linkedSessionId != nil {
                    chainSection
                }

                activityFeed
            }
            .padding(20)
        }
        .task(id: pod.id) {
            await fetchQuality()
        }
        .onAppear {
            startPollingIfNeeded()
        }
        .onDisappear {
            poller.stop()
        }
        .onChange(of: pod.status) { _, newStatus in
            poller.stopIfTerminal(status: newStatus)
            if !newStatus.isTerminal { startPollingIfNeeded() }
        }
        .onChange(of: pod.id) { _, _ in
            poller.stop()
            startPollingIfNeeded()
        }
    }

    // MARK: - Overview summary

    private var overviewStatusStrip: some View {
        let accent = pod.status.color
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: overviewStatusIcon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(accent)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(overviewStatusTitle)
                    .font(.callout.weight(.semibold))
                Text(overviewStatusSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Text(pod.status.label)
                .font(.system(.caption2, design: .monospaced).weight(.semibold))
                .foregroundStyle(accent)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(accent.opacity(0.12), in: Capsule())
        }
        .padding(14)
        .background(accent.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(accent.opacity(0.16), lineWidth: 1))
    }

    private var overviewStatusIcon: String {
        switch pod.status {
        case .failed: "xmark.seal.fill"
        case .reviewRequired, .awaitingInput: "exclamationmark.triangle.fill"
        case .complete: "checkmark.seal.fill"
        case .running, .validating, .provisioning, .merging, .mergePending, .handoff:
            "arrow.triangle.2.circlepath"
        default: "circle"
        }
    }

    private var overviewStatusTitle: String {
        if pod.worktreeCompromised { return "Worktree needs recovery" }
        switch pod.status {
        case .failed: return "Pod failed"
        case .reviewRequired: return "Human review required"
        case .awaitingInput: return "Agent needs input"
        case .complete: return "Pod complete"
        case .validating: return "Validation running"
        case .running: return "Agent running"
        default: return pod.status.label.capitalized
        }
    }

    private var overviewStatusSubtitle: String {
        if pod.worktreeCompromised {
            return "Recover the worktree before retrying or continuing this pod."
        }
        if let err = pod.errorSummary, (pod.status == .failed || pod.status == .reviewRequired) {
            return err
        }
        if let phase = pod.phase {
            return phase.description
        }
        return "\(pod.profileName) on \(pod.branch)"
    }

    private var overviewSnapshotGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
            snapshotTile(icon: "person.text.rectangle", label: "Profile", value: pod.profileName)
            snapshotTile(icon: "arrow.triangle.branch", label: "Branch", value: pod.branch)
            snapshotTile(icon: "clock", label: "Duration", value: pod.duration)
            snapshotTile(icon: "dollarsign.circle", label: "Cost", value: String(format: "$%.3f", pod.costUsd))
            if let diff = pod.diffStats {
                snapshotTile(icon: "doc.text", label: "Diff", value: "\(diff.files) files, +\(diff.added)/-\(diff.removed)")
            }
            if let quality {
                snapshotTile(icon: "checkmark.seal", label: "Quality", value: quality.score.map { "\($0)/100" } ?? quality.grade.capitalized)
            } else {
                snapshotTile(icon: "checkmark.seal", label: "Quality", value: "—")
            }
        }
    }

    private func snapshotTile(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Text(value)
                    .font(.system(.caption, design: label == "Branch" ? .monospaced : .default).weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Quality

    private func fetchQuality() async {
        guard let loadQuality else { return }
        do {
            quality = try await loadQuality(pod.id)
        } catch {
            quality = nil
        }
    }

    // MARK: - Preview polling

    private var shouldPollPreview: Bool {
        guard pod.hasWebUi, loadPreviewStatus != nil else { return false }
        switch pod.status {
        case .running, .validating, .validated, .awaitingInput, .paused: return true
        default: return false
        }
    }

    private func startPollingIfNeeded() {
        guard shouldPollPreview, let load = loadPreviewStatus else { return }
        poller.start(podId: pod.id, load: load)
    }

    // MARK: - Preview card

    private var compactPreviewCard: some View {
        let running = poller.status?.running ?? false
        let reachable = poller.status?.reachable ?? false
        let restartCount = poller.status?.restartCount ?? 0
        let urlString = poller.status?.previewUrl
        let accentColor: Color = running && reachable ? .green
            : running && !reachable ? .orange
            : .secondary

        return HStack(spacing: 10) {
            Image(systemName: running && reachable ? "play.circle.fill" : "play.rectangle")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(accentColor)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Preview")
                        .font(.caption.weight(.semibold))
                    if restartCount > 0 {
                        Text("\(restartCount) restart\(restartCount == 1 ? "" : "s")")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.orange)
                    }
                }
                Text(compactPreviewSubtitle(running: running, reachable: reachable, urlString: urlString))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            if let urlString {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(urlString, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Copy preview URL")
            }

            Button {
                Task { await actions.openLiveApp(pod.id) }
            } label: {
                Label("Open", systemImage: "play.fill")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(running && reachable ? .green : nil)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(accentColor.opacity(0.16), lineWidth: 1))
    }

    private func compactPreviewSubtitle(running: Bool, reachable: Bool, urlString: String?) -> String {
        if let error = poller.lastFetchError { return "Status check failed: \(error)" }
        if let urlString { return urlString }
        if running && !reachable { return "Server is starting or respawning" }
        if running { return "Preview server running" }
        return "No preview active"
    }

    private var previewCard: some View {
        let running = poller.status?.running ?? false
        let reachable = poller.status?.reachable ?? false
        let restartCount = poller.status?.restartCount ?? 0
        let urlString = poller.status?.previewUrl

        let accentColor: Color = running && reachable ? .green
            : running && !reachable ? .orange
            : Color(nsColor: .separatorColor)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "play.rectangle.fill")
                    .foregroundStyle(running && reachable ? .green : running ? .orange : .secondary)
                    .font(.system(size: 12))
                Text("Preview")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                if restartCount > 0 || (running && !reachable) {
                    Text("restarts: \(restartCount)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            if let fetchError = poller.lastFetchError {
                Label("Status check failed: \(fetchError)", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.yellow)
                    .lineLimit(2)
            } else if running && !reachable {
                Label("Server unreachable, supervisor respawning", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if !running {
                Text("No preview active")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let urlString {
                HStack(spacing: 6) {
                    Text(urlString)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(urlString, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("Copy to clipboard")
                }
            }

            Button {
                Task { await actions.openLiveApp(pod.id) }
            } label: {
                Label("Open live app", systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .controlSize(.small)
        }
        .padding(14)
        .background(
            running && reachable ? Color.green.opacity(0.05) :
            running && !reachable ? Color.orange.opacity(0.05) :
            Color(nsColor: .controlBackgroundColor)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(accentColor.opacity(0.2), lineWidth: 1)
        )
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

            Markdown(question)
                .markdownTheme(.autopod)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let options = pod.escalationOptions, !options.isEmpty {
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

            Markdown(question)
                .markdownTheme(.autopod)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

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
        AgentPhaseProgressView(phase: phase, variant: .compact)
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
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "person.text.rectangle")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
                Text("Profile")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 42, alignment: .leading)
                Text(pod.profileName)
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                    .foregroundStyle(.primary)
                if let version = pod.profileSnapshot?.version {
                    Text("v\(version)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                }
                Spacer()
            }
            .padding(.vertical, 7)

            Divider()

            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
                Text("Branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 42, alignment: .leading)
                Text(pod.branch)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.vertical, 7)
        }
        .padding(.horizontal, 12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Artifacts

    private func artifactsSection(_ artifactsPath: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "archivebox.fill")
                    .foregroundStyle(.blue)
                Text("Artifacts")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                Button {
                    let url = URL(fileURLWithPath: artifactsPath)
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } label: {
                    Label("Reveal in Finder", systemImage: "folder")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            Text(artifactsPath)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .padding(14)
        .background(Color.blue.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.blue.opacity(0.15), lineWidth: 1)
        )
    }

    // MARK: - Infrastructure (sidecars + test-pipeline branches)

    private var infrastructureSection: some View {
        DisclosureGroup(isExpanded: $infrastructureExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                if !pod.requireSidecars.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sidecars requested")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            ForEach(pod.requireSidecars, id: \.self) { name in
                                Text(name)
                                    .font(.system(.caption, design: .monospaced))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Color.purple.opacity(0.12))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }

                if !pod.sidecarContainerIds.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Running containers")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(pod.sidecarContainerIds.sorted(by: { $0.key < $1.key }), id: \.key) { name, id in
                            HStack(spacing: 6) {
                                Text(name)
                                    .font(.caption.weight(.medium))
                                    .frame(width: 70, alignment: .leading)
                                Text(String(id.prefix(12)))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }

                if !pod.testRunBranches.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Active test-run branches")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(pod.testRunBranches, id: \.self) { branch in
                            Text(branch)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .padding(.top, 8)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "cube.box.fill")
                    .foregroundStyle(.purple)
                    .font(.system(size: 12))
                Text("Infrastructure")
                    .font(.system(.subheadline).weight(.semibold))
            }
        }
        .padding(14)
        .background(Color.purple.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.purple.opacity(0.15), lineWidth: 1)
        )
    }

    // MARK: - Metrics

    private var metricsCard: some View {
        let hasCostData = pod.inputTokens > 0 || pod.outputTokens > 0 || pod.costUsd > 0
            || pod.status == .running || pod.status == .paused
        let toolCallCount = events.filter { $0.type == .toolUse }.count

        return HStack(alignment: .top, spacing: 0) {
            // Effort column
            VStack(alignment: .leading, spacing: 8) {
                Text("EFFORT")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .tracking(0.5)

                metricRow(icon: "clock", value: pod.duration, label: "Duration")

                if let diff = pod.diffStats {
                    metricRow(icon: "doc.text", value: "\(diff.files)", label: "Files")
                    metricRow(icon: "plus", value: "+\(diff.added)", label: "Lines added", color: .green)
                    metricRow(icon: "minus", value: "\(diff.removed)", label: "Lines removed", color: .red)
                }

                metricRow(icon: "wrench", value: "\(toolCallCount)", label: "Tool calls")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)

            Divider()

            // Cost column
            VStack(alignment: .leading, spacing: 8) {
                Text("COST")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .tracking(0.5)

                if hasCostData {
                    let costKnown = pod.costUsd > 0
                    let costInProgress = pod.status == .running || pod.status == .paused
                    let costDisplay = (!costKnown && costInProgress) ? "—" : String(format: "$%.3f", pod.costUsd)

                    metricRow(icon: "arrow.up.circle",
                              value: formatTokens(pod.inputTokens),
                              label: "Tokens in",
                              color: pod.inputTokens > 0 ? .primary : .secondary)
                    metricRow(icon: "arrow.down.circle",
                              value: formatTokens(pod.outputTokens),
                              label: "Tokens out",
                              color: pod.outputTokens > 0 ? .primary : .secondary)
                    metricRow(icon: "dollarsign.circle",
                              value: costDisplay,
                              label: "Cost",
                              color: costKnown ? .primary : .secondary)
                } else {
                    Text("No token data yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)

            Divider()

            // Quality column
            VStack(alignment: .leading, spacing: 8) {
                Text("QUALITY")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .tracking(0.5)

                if let signals = quality {
                    let scoreDisplay = signals.score.map { "\($0)/100" } ?? "—"
                    metricRow(icon: "checkmark.seal",
                              value: scoreDisplay,
                              label: "Score",
                              color: signals.score == nil ? .secondary : qualityColor(signals.grade))

                    let readEditDisplay = signals.editCount == 0
                        ? "—"
                        : String(format: "%.1f", signals.readEditRatio)
                    metricRow(icon: "doc.text.magnifyingglass",
                              value: readEditDisplay,
                              label: "Read / Edit")

                    metricRow(icon: "eye.slash",
                              value: "\(signals.editsWithoutPriorRead)",
                              label: "Blind edits")
                    metricRow(icon: "arrow.triangle.2.circlepath",
                              value: "\(signals.editChurnCount)",
                              label: "Churn")
                    metricRow(icon: "hand.raised",
                              value: "\(signals.userInterrupts)",
                              label: "Interrupts")
                } else {
                    Text("No quality data yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func qualityColor(_ grade: String) -> Color {
        switch grade.lowercased() {
        case "green": return .green
        case "yellow": return .yellow
        case "red": return .red
        default: return .secondary
        }
    }

    private func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return "\(count / 1_000)K" }
        return "\(count)"
    }

    private func metricRow(icon: String, value: String, label: String, color: Color = .primary) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 0) {
                Text(value)
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - Commits

    private var commitSection: some View {
        let elapsed = Date().timeIntervalSince(pod.startedAt)
        let elapsedMins = elapsed / 60
        let pace: String? = elapsedMins > 0 && pod.commitCount > 0
            ? String(format: "%.1f/hr", Double(pod.commitCount) / elapsedMins * 60)
            : nil
        let isStale = elapsedMins >= 30 && pod.commitCount == 0
            && (pod.status == .running || pod.status == .paused)

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
            let filled = min(pod.commitCount, maxDots)
            HStack(spacing: 3) {
                ForEach(0..<maxDots, id: \.self) { i in
                    Circle()
                        .fill(i < filled ? Color.green : Color(nsColor: .separatorColor))
                        .frame(width: 8, height: 8)
                }
                if pod.commitCount > maxDots {
                    Text("+\(pod.commitCount - maxDots)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(pod.commitCount) commit\(pod.commitCount == 1 ? "" : "s")")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(pod.commitCount > 0 ? .primary : .secondary)
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
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal")
                    .foregroundStyle(.secondary)
                Text("Validation")
                    .font(.system(.subheadline).weight(.semibold))
            }
            HStack(spacing: 8) {
                validationChip("Smoke Tests", status: checks.smoke, icon: "flame")
                validationChip("Test Suite", status: checks.tests, icon: "testtube.2")
                validationChip("Code Review", status: checks.review, icon: "eye")
                Spacer()
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func validationChip(_ label: String, status: Bool?, icon: String) -> some View {
        let color: Color = switch status {
        case true: .green
        case false: .red
        case nil: Color.secondary
        }
        let iconName: String = switch status {
        case true: "checkmark.circle.fill"
        case false: "xmark.circle.fill"
        case nil: "minus.circle"
        }
        return HStack(spacing: 5) {
            Image(systemName: iconName)
                .font(.system(size: 11))
                .foregroundStyle(color)
            Text(label)
                .font(.caption)
                .foregroundStyle(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Review

    private var reviewRequiredSection: some View {
        let accentColor: Color = .orange
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(accentColor)
                Text("Review Required")
                    .font(.system(.subheadline).weight(.semibold))
            }
            Text("Validation attempts exhausted — a human should decide whether to extend or fix manually.")
                .font(.callout)
                .foregroundStyle(.secondary)
            if let err = pod.errorSummary {
                Text(err)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(accentColor)
            }
            if let a = pod.attempts {
                Text(a.reworkCount > 0 ? "Rework \(a.reworkCount) — Attempt \(a.current) of \(a.max)" : "Attempt \(a.current) of \(a.max)")
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

    // MARK: - Pod chain

    private var chainSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "link")
                    .foregroundStyle(.purple)
                Text("Pod Chain")
                    .font(.system(.subheadline).weight(.semibold))
            }

            if let linked = pod.linkedSessionId {
                VStack(alignment: .leading, spacing: 0) {
                    if pod.isWorkspace {
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
                            id: pod.id,
                            label: "Fix (workspace)",
                            detail: pod.status.label,
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
                            id: pod.id,
                            label: "Worker",
                            detail: pod.status.label,
                            icon: "gearshape",
                            color: pod.status.color,
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
        ActivityFeedList(events: events, maxCount: 6)
    }

    // MARK: - Reply

    private func sendReply() {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        replyText = ""
        Task { await actions.reply(pod.id, text) }
    }
}

// MARK: - Previews

#Preview("Overview — running") {
    OverviewTab(pod: MockData.running, events: MockEvents.running)
        .frame(width: 550, height: 600)
}

#Preview("Overview — awaiting input") {
    OverviewTab(pod: MockData.awaitingInput, events: MockEvents.awaitingInput)
        .frame(width: 550, height: 500)
}

#Preview("Overview — validated") {
    OverviewTab(pod: MockData.validated, events: MockEvents.running)
        .frame(width: 550, height: 500)
}

#Preview("Overview — failed") {
    OverviewTab(pod: MockData.failed, events: MockEvents.failed)
        .frame(width: 550, height: 500)
}

#Preview("Overview — worker with ACs") {
    OverviewTab(pod: MockData.workerFromWorkspace, events: MockEvents.running)
        .frame(width: 550, height: 600)
}

#Preview("Overview — running with web UI (Running state)") {
    OverviewTab(
        pod: MockData.runningWithWebUi,
        events: MockEvents.running,
        loadPreviewStatus: { _ in
            PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: "http://127.0.0.1:17668")
        }
    )
    .frame(width: 550, height: 650)
}

#Preview("Overview — restarting web UI (Restarting state, amber)") {
    OverviewTab(
        pod: MockData.restartingWithWebUi,
        events: MockEvents.running,
        loadPreviewStatus: { _ in
            PreviewStatus(running: true, reachable: false, restartCount: 2, lastError: nil, previewUrl: "http://127.0.0.1:17668")
        }
    )
    .frame(width: 550, height: 650)
}

#Preview("Overview — stopped web UI (Stopped state, muted)") {
    OverviewTab(
        pod: MockData.stoppedWithWebUi,
        events: MockEvents.running,
        loadPreviewStatus: { _ in
            PreviewStatus(running: false, reachable: false, restartCount: 0, lastError: nil, previewUrl: nil)
        }
    )
    .frame(width: 550, height: 650)
}

#Preview("Overview — running, no web UI (card hidden)") {
    OverviewTab(pod: MockData.running, events: MockEvents.running)
        .frame(width: 550, height: 600)
}
