import AutopodClient
import SwiftUI

struct DesktopSeriesNavigation: View {
    let pods: [Pod]
    @Binding var selectedID: String?
    @State private var includeCompleted = false
    private var groups: [DesktopSeriesGroup] { DesktopSeriesGroup.groups(pods, includeCompleted: includeCompleted) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Series").font(.title2.weight(.semibold))
            Toggle("Show completed", isOn: $includeCompleted).toggleStyle(.checkbox).font(.caption)
            if groups.isEmpty {
                ContentUnavailableView("No series", systemImage: "rectangle.3.group", description: Text("Series appear when member pods share a series relationship."))
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(groups) { group in
                            Button { selectedID = group.id } label: {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        Text(group.attentionCount > 0 ? "Needs attention" : group.isActive ? "Active" : group.failedCount > 0 ? "Failed" : "Complete")
                                            .foregroundStyle(group.failedCount > 0 ? Color.red : group.attentionCount > 0 ? .orange : DesktopTheme.accent)
                                        Spacer()
                                        Text("\(group.pods.count) pods").foregroundStyle(.secondary)
                                    }.font(.caption2)
                                    Text(group.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                                    if let description = group.description {
                                        Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                    Text("\(group.completedCount) complete · \(group.queuedCount) queued").font(.caption2).foregroundStyle(.secondary)
                                    Text(String(format: "$%.2f", group.totalCost)).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                                }
                                .padding(15).frame(maxWidth: .infinity, alignment: .leading)
                                .background(selectedID == group.id ? DesktopTheme.selection : DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9).stroke(selectedID == group.id ? DesktopTheme.accent : DesktopTheme.line, lineWidth: 1))
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("desktop-series-\(group.id)")
                        }
                    }
                }
            }
        }
        .padding(20).background(DesktopTheme.canvas)
        .onAppear { normalizeSelection() }
        .onChange(of: groups.map(\.id)) { _, _ in normalizeSelection() }
    }

    private func normalizeSelection() {
        if !groups.contains(where: { $0.id == selectedID }) { selectedID = groups.first?.id }
    }
}

struct DesktopSeriesWorkspace: View {
    let group: DesktopSeriesGroup
    var qualityScores: [String: PodQualityScore]
    var actions: PodActions
    var eventsForPod: ((String) -> [AgentEvent])?
    var loadEventsForPod: ((String) -> Void)?
    var loadQuality: ((String) async throws -> PodQualitySignals)?
    var openPod: (String, DetailTab) -> Void
    @State private var confirmDelete = false
    @Environment(\.desktopRepositories) private var repositories

    private var repositoryLabels: [String] {
        Array(Set(group.pods.compactMap { repositories[$0.id]?.label })).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { metrics }
                VStack(spacing: 12) { metrics }
            }.padding(20)
            SeriesPipelineView(
                pods: group.pods, qualityScores: qualityScores,
                onSelectPod: { openPod($0, .overview) }, panelEnabled: true,
                actions: actions, eventsForPod: eventsForPod,
                loadEventsForPod: loadEventsForPod, loadQuality: loadQuality
            )
            .environment(\.desktopSeriesOpenPod, openPod)
            .id(group.id)
        }
        .background(DesktopTheme.surface)
        .confirmationDialog("Delete \(group.name)?", isPresented: $confirmDelete) {
            Button("Delete Series", role: .destructive) { Task { await actions.deleteSeries(group.id) } }
        } message: {
            Text("Kills running pods and permanently removes all \(group.pods.count) pods in this series.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(group.attentionCount > 0 ? "Needs attention" : group.isActive ? "Active" : "Finished")
                    .font(.caption.weight(.semibold)).foregroundStyle(group.attentionCount > 0 ? Color.orange : DesktopTheme.accent)
                Spacer()
                if group.pods.contains(where: { $0.prUrl != nil }) {
                    Menu("Pull requests") {
                        ForEach(group.pods.filter { $0.prUrl != nil }) { pod in
                            if let url = pod.prUrl { Link("\(pod.desktopTitle) · \(pod.profileName)", destination: url) }
                        }
                    }.menuStyle(.borderlessButton).fixedSize()
                }
                Menu {
                    Button("Delete Series…", role: .destructive) { confirmDelete = true }
                } label: { Image(systemName: "ellipsis").padding(4) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("Series actions")
            }
            Text(group.name).font(.system(size: 27, weight: .semibold))
            Label(repositoryLabels.isEmpty ? "Repository unavailable" : repositoryLabels.joined(separator: " · "), systemImage: "folder")
                .font(.caption).foregroundStyle(DesktopTheme.accent).textSelection(.enabled)
            if let description = group.description { Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
        }.padding(24)
    }

    @ViewBuilder private var metrics: some View {
        metric("Member pods complete", value: "\(group.completedCount) / \(group.pods.count)", detail: "\(group.failedCount) failed · \(group.queuedCount) queued")
        metric("Needs attention", value: "\(group.attentionCount) \(group.attentionCount == 1 ? "pod" : "pods")", detail: "Recorded member status")
        metric("Total recorded cost", value: String(format: "$%.2f", group.totalCost), detail: "Across \(repositoryLabels.count) repositories")
    }
    private func metric(_ title: String, value: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.title2.weight(.semibold)).monospacedDigit()
            if title == "Member pods complete" { ProgressView(value: group.completion).tint(DesktopTheme.accent) }
            Text(detail).font(.caption2).foregroundStyle(.secondary)
        }
        .padding(16).frame(minWidth: 150, maxWidth: .infinity, minHeight: 112, maxHeight: 112, alignment: .leading)
        .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(DesktopTheme.line, lineWidth: 1))
    }
}
