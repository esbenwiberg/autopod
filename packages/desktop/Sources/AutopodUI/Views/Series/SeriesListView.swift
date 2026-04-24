import SwiftUI

/// Full-page series list — shown when "Series" is selected in the sidebar.
/// One collapsible card per series, with an inline DAG on expand.
/// Defaults to active-only (series with ≥1 non-terminal pod); toggle reveals completed.
public struct SeriesListView: View {
    public let pods: [Pod]
    /// The currently selected pod ID — used only for highlighting nodes in the DAG.
    public var selectedPodId: String?
    /// Called when the user taps a pipeline node. The parent sets selectedSessionId
    /// and can also override the detail tab (e.g. to .overview).
    public var onSelectPod: (String) -> Void
    public var actions: PodActions

    public init(
        pods: [Pod],
        selectedPodId: String? = nil,
        onSelectPod: @escaping (String) -> Void = { _ in },
        actions: PodActions
    ) {
        self.pods = pods
        self.selectedPodId = selectedPodId
        self.onSelectPod = onSelectPod
        self.actions = actions
    }

    @State private var showCompleted = false
    @State private var expandedIds = Set<String>()
    @State private var showDeleteConfirmation: String?

    private let terminalStatuses: Set<PodStatus> = [.complete, .killed, .failed]

    private struct SeriesGroup: Identifiable {
        let id: String
        let name: String
        let pods: [Pod]
        var isActive: Bool
        var runningCount: Int
        var queuedCount: Int
        var completedCount: Int
        var failedCount: Int
        var totalCost: Double
    }

    private var groups: [SeriesGroup] {
        let bySeries = Dictionary(grouping: pods.filter { $0.seriesId != nil }, by: { $0.seriesId! })
        return bySeries.values.compactMap { group -> SeriesGroup? in
            guard let first = group.first, let sid = first.seriesId else { return nil }
            let name = first.seriesName ?? sid
            let isActive = group.contains { !terminalStatuses.contains($0.status) }
            let running = group.filter { $0.status.isActive || $0.status.needsAttention }.count
            let queued = group.filter { $0.status == .queued || $0.status == .paused }.count
            let completed = group.filter { terminalStatuses.contains($0.status) }.count
            let failed = group.filter { $0.status == .failed || $0.status == .killed }.count
            let cost = group.reduce(0.0) { $0 + $1.costUsd }
            return SeriesGroup(
                id: sid, name: name, pods: group.sorted { $0.startedAt < $1.startedAt },
                isActive: isActive, runningCount: running, queuedCount: queued,
                completedCount: completed, failedCount: failed, totalCost: cost
            )
        }
        .filter { showCompleted || $0.isActive || $0.failedCount > 0 }
        .sorted { a, b in
            if a.isActive != b.isActive { return a.isActive }
            guard let aDate = a.pods.first?.startedAt, let bDate = b.pods.first?.startedAt else { return false }
            return aDate > bDate
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if groups.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(groups) { group in
                            seriesCard(group)
                        }
                    }
                    .padding(16)
                }
            }
        }
    }

    private var header: some View {
        HStack {
            Text("Series")
                .font(.headline)
            Text("\(groups.count)")
                .font(.system(.caption2).weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.blue.opacity(0.1))
                .foregroundStyle(.blue)
                .clipShape(Capsule())
            Spacer()
            Toggle(isOn: $showCompleted) {
                Text("Show completed")
                    .font(.caption)
            }
            .toggleStyle(.checkbox)
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "rectangle.3.group")
                .font(.system(size: 32))
                .foregroundStyle(.tertiary)
            Text(showCompleted ? "No series" : "No active series")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if !showCompleted {
                Button("Show completed") { showCompleted = true }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.blue)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func seriesCard(_ group: SeriesGroup) -> some View {
        let isExpanded = expandedIds.contains(group.id)

        VStack(spacing: 0) {
            // Header row — always visible
            Button {
                if isExpanded { expandedIds.remove(group.id) }
                else { expandedIds.insert(group.id) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 12)

                    Image(systemName: "rectangle.3.group.fill")
                        .foregroundStyle(group.isActive ? Color.accentColor : (group.failedCount > 0 ? .red : .secondary))
                        .font(.system(size: 13))

                    Text(group.name)
                        .font(.system(.subheadline).weight(.semibold))
                        .lineLimit(1)

                    if group.isActive {
                        statusChip(
                            "\(group.runningCount) running",
                            color: group.runningCount > 0 ? .blue : .secondary
                        )
                        if group.queuedCount > 0 {
                            statusChip("\(group.queuedCount) queued", color: .gray)
                        }
                    } else if group.failedCount > 0 {
                        statusChip("failed", color: .red)
                    } else {
                        statusChip("complete", color: .green)
                    }

                    Spacer()

                    Text(String(format: "$%.2f", group.totalCost))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)

                    Button(role: .destructive) {
                        showDeleteConfirmation = group.id
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                            .foregroundStyle(.red.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                    .onTapGesture {} // prevent card toggle
                    .confirmationDialog(
                        "Delete \"\(group.name)\"?",
                        isPresented: Binding(
                            get: { showDeleteConfirmation == group.id },
                            set: { if !$0 { showDeleteConfirmation = nil } }
                        )
                    ) {
                        Button("Delete Series", role: .destructive) {
                            Task { await actions.deleteSeries(group.id) }
                        }
                    } message: {
                        Text("Kills all running pods and permanently removes all \(group.pods.count) pods in this series.")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .buttonStyle(.plain)

            // Inline DAG — visible when expanded
            if isExpanded {
                Divider()
                SeriesPipelineView(
                    pods: group.pods,
                    selectedPodId: selectedPodId,
                    onSelectPod: onSelectPod
                )
                .frame(minHeight: 160, maxHeight: 320)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        )
    }

    private func statusChip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(.caption2).weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(color.opacity(0.1))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}
