import AutopodClient
import SwiftUI

public struct DesktopHistoryWorkspace: View {
    public let pods: [Pod]
    public let configuration: LaunchConfigurationActions?
    public let refresh: (() async -> Void)?
    public let openPod: (String) -> Void
    public var isConnected: Bool
    public var isLoading: Bool
    public var loadError: String?
    @Environment(\.desktopRepositories) private var repositories
    @State private var filter = DesktopHistoryFilter()
    @State private var tab: String
    @State private var selectedID: String?
    @State private var refreshing = false

    public init(pods: [Pod], configuration: LaunchConfigurationActions? = nil,
                refresh: (() async -> Void)? = nil, openPod: @escaping (String) -> Void,
                isConnected: Bool = true, isLoading: Bool = false, loadError: String? = nil,
                initialTab: String = "Past pods") {
        self.pods = pods; self.configuration = configuration; self.refresh = refresh; self.openPod = openPod
        self.isConnected = isConnected; self.isLoading = isLoading; self.loadError = loadError
        _tab = State(initialValue: initialTab)
    }
    private var matches: [Pod] {
        let now = Date()
        return pods.filter { filter.matches($0, repository: repositories[$0.id], now: now) }
            .sorted { $0.startedAt > $1.startedAt }
    }
    private var selected: Pod? { matches.first { $0.id == selectedID } ?? matches.first }
    private var cohort: [Pod] {
        let now = Date()
        return pods.filter { !$0.isWorkspace && (filter.days == 0 || $0.startedAt >= now.addingTimeInterval(-Double(filter.days) * 86400)) }
    }
    public var body: some View {
        VStack(spacing: 0) {
            DesktopInsightsHeader(title: "History", subtitle: "Return to a pod, investigate a pattern, or open a history workspace.") {
                HStack {
                    Button { Task { refreshing = true; await refresh?(); refreshing = false } } label: {
                        Label(refreshing ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                    }.disabled(refresh == nil || refreshing || !isConnected)
                    AnalysisWorkspaceLauncher(kind: "history", actions: isConnected ? configuration : nil)
                }
            }
            if !isConnected {
                Label("Disconnected · loaded records may be stale. Connect to refresh or launch a workspace.", systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(.secondary).padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(DesktopTheme.canvas)
            }
            if let loadError {
                Label(loadError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange).padding(14)
            }
            DesktopSectionPicker(title: "", items: ["Past pods", "Patterns"], selection: $tab, label: { $0 })
            HStack {
                Text(tab == "Past pods" ? "Loaded worker records · older/deleted work via History Workspace" : "Patterns across loaded workers · active sessions remain in denominators")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Picker("Started", selection: $filter.days) {
                    Text("Last 7 days").tag(7); Text("Last 30 days").tag(30)
                    Text("Last 90 days").tag(90); Text("All loaded").tag(0)
                }.fixedSize().controlSize(.small)
            }.padding(.horizontal, 24).padding(.vertical, 12).background(DesktopTheme.canvas)
            if isLoading && pods.isEmpty { ProgressView("Loading history…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if tab == "Patterns" { patterns }
            else {
                GeometryReader { geo in
                    if geo.size.width >= 1100 {
                        HStack(spacing: 0) {
                            browser.frame(maxWidth: .infinity)
                            DesktopTheme.line.frame(width: 1)
                            ScrollView { inspector.padding(24) }.frame(width: max(380, geo.size.width * 0.36))
                                .background(DesktopTheme.canvas)
                        }
                    } else {
                        ScrollView { VStack(spacing: 0) { browserContent; Divider(); inspector.padding(24) } }
                    }
                }
            }
        }.background(DesktopTheme.surface)
    }
    private var browser: some View { ScrollView { browserContent } }
    private var browserContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            TextField("Search tasks, repositories, pod IDs…", text: $filter.query).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("history-search")
            ViewThatFits(in: .horizontal) { HStack { filters }; VStack(alignment: .leading) { filters } }
            if matches.isEmpty {
                ContentUnavailableView { Label("No matching pods", systemImage: "clock.arrow.circlepath") }
                    description: { Text("Try a different repository, outcome or search. History searches the pod records already loaded in this app.") }
                    actions: { Button("Clear filters") { filter = DesktopHistoryFilter() } }
            } else {
                LazyVStack(spacing: 9) {
                    ForEach(matches) { pod in
                        Button { selectedID = pod.id } label: { historyRow(pod) }
                            .buttonStyle(.plain).accessibilityAddTraits(selected?.id == pod.id ? .isSelected : [])
                    }
                }
            }
            HStack {
                Text("\(matches.count) matching loaded records · newest first").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button("Clear filters") { filter = DesktopHistoryFilter() }.font(.caption)
            }
            Text("Older records outside this app’s loaded collection can be investigated through the existing history export workspace.")
                .font(.caption).foregroundStyle(.secondary)
        }.padding(24)
    }
    @ViewBuilder private var filters: some View {
        Picker("Repository", selection: $filter.repository) {
            Text("All repositories").tag("all")
            ForEach(Dictionary(grouping: Array(repositories.values), by: \.id).values.compactMap { $0.first }.sorted { $0.label < $1.label }, id: \.id) { repo in Text(repo.label).tag(repo.id) }
            Text("Unknown repository / legacy").tag("unknown")
        }
        Picker("Profile", selection: $filter.profile) {
            Text("All profiles").tag("all")
            ForEach(Array(Set(pods.map(\.profileName))).sorted(), id: \.self) { Text($0).tag($0) }
        }
        Picker("Outcome", selection: $filter.outcome) {
            Text("All outcomes").tag("all"); Text("Failed, stopped & review").tag("attention")
            ForEach(Array(Set(pods.map(\.status))).sorted { $0.rawValue < $1.rawValue }, id: \.self) { Text($0.label).tag($0.rawValue) }
        }
    }
    private func historyRow(_ pod: Pod) -> some View {
        HStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 7) {
                Text(pod.desktopTitle).font(.callout.weight(.medium)).lineLimit(2)
                Text("\(repositories[pod.id]?.label ?? "Unknown repository") · \(pod.profileName) · \(pod.id)")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Text(pod.status.label).font(.caption2.weight(.medium)).foregroundStyle(pod.status.color)
            VStack(alignment: .trailing, spacing: 5) {
                Text(pod.startedAt, style: .date)
                Text(pod.costUsd, format: .currency(code: "USD"))
            }.font(.caption2).monospacedDigit().foregroundStyle(.secondary)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(selected?.id == pod.id ? DesktopTheme.selection : DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(selected?.id == pod.id ? DesktopTheme.accent : DesktopTheme.line))
    }
    @ViewBuilder private var inspector: some View {
        if let pod = selected {
            VStack(alignment: .leading, spacing: 21) {
                HStack {
                    Text(pod.status.label).font(.caption.weight(.medium)).foregroundStyle(pod.status.color)
                    Text(pod.id).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Open pod ↗") { openPod(pod.id) }.controlSize(.small)
                }
                Text(pod.desktopTitle).font(.system(size: 24, weight: .semibold)).textSelection(.enabled)
                Button { filter.repository = repositories[pod.id]?.id ?? "unknown" } label: {
                    Label(repositories[pod.id]?.label ?? "Unknown repository", systemImage: "line.3.horizontal.decrease.circle")
                }.buttonStyle(.plain).font(.callout).foregroundStyle(DesktopTheme.accent)
                if repositories[pod.id]?.isSnapshot == false { Text("Repository from current profile; snapshot unavailable.").font(.caption2).foregroundStyle(.secondary) }
                PodLifecycleRail(pod: pod)
                Text("Autopod lifecycle · \(pod.desktopLifecycleStage?.rawValue ?? pod.status.label)").font(.caption2).foregroundStyle(.secondary)
                Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 16) {
                    GridRow { fact("Profile", pod.profileName); fact("Recorded cost", String(format: "$%.2f", pod.costUsd)) }
                    GridRow { fact("Milestones", pod.desktopMilestoneToken ?? "Not recorded"); fact("Validation attempt", pod.attempts.map { "\($0.current) of \($0.max)" } ?? "Not recorded") }
                }
                fact("Branch", pod.branch)
                if let phase = pod.phase { ReportedMilestoneView(phase: phase) }
                DesktopPanel(title: pod.errorSummary == nil ? "Task summary" : "Outcome & blocker") {
                    Text(pod.taskSummary?.actualSummary ?? (pod.task.isEmpty ? "No task summary was recorded." : pod.task)).font(.callout).textSelection(.enabled)
                    if let error = pod.errorSummary { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                }
                Text("Open the full pod for Work, Validation, Readiness, Evidence, Diff, Logs and Terminal.")
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
        } else { ContentUnavailableView("Select a pod", systemImage: "shippingbox") }
    }
    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(label).font(.caption2).foregroundStyle(.secondary); Text(value).font(.callout).textSelection(.enabled) }
    }
    private var patterns: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                let attention = cohort.filter(DesktopHistoryFilter.needsAttention)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 160))], alignment: .leading, spacing: 12) {
                    fact("Loaded workers", "\(cohort.count)").desktopAnalyticsPanel()
                    fact("Failed / stopped / review", "\(attention.count)").desktopAnalyticsPanel()
                    fact("Attention share", cohort.isEmpty ? "—" : "\(Int(Double(attention.count) / Double(cohort.count) * 100))%").desktopAnalyticsPanel()
                    fact("Spend in this group", String(format: "$%.2f", attention.reduce(0) { $0 + $1.costUsd })).desktopAnalyticsPanel()
                }
                DesktopPanel(title: "By profile") {
                    ForEach(Array(Set(cohort.map(\.profileName))).sorted(), id: \.self) { name in
                        let group = cohort.filter { $0.profileName == name }
                        let settled = group.filter { $0.status != .running && $0.status != .paused }
                        let attempts = group.compactMap(\.attempts)
                        VStack(alignment: .leading, spacing: 10) {
                            Text(name).font(.callout.weight(.semibold))
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 24) { profileFacts(group, settled: settled, attempts: attempts) }
                                VStack(alignment: .leading, spacing: 12) { profileFacts(group, settled: settled, attempts: attempts) }
                            }
                        }.padding(.vertical, 12)
                        Divider()
                    }
                    Text("Completed share uses all loaded workers in the selected start-date window. Attention groups failed, killed and review-required outcomes. Rework means more than one validation attempt.").font(.caption).foregroundStyle(.secondary)
                }
                DesktopPanel(title: "Recent attention") {
                    if attention.isEmpty { Text("No failed, stopped or review-required workers in this collection.").foregroundStyle(.secondary) }
                    ForEach(Array(attention.sorted { $0.startedAt > $1.startedAt }.prefix(10))) { pod in
                        Button { openPod(pod.id) } label: { historyRow(pod) }.buttonStyle(.plain)
                    }
                }
                DesktopPanel(title: "Deep investigation") {
                    Text("Explore a SQLite history export in an interactive workspace. Choose repository and configuration, then preview the effective setup before launching.").font(.callout).foregroundStyle(.secondary)
                    AnalysisWorkspaceLauncher(kind: "history", actions: isConnected ? configuration : nil)
                }
            }.padding(24)
        }
    }
    @ViewBuilder private func profileFacts(_ group: [Pod], settled: [Pod], attempts: [AttemptInfo]) -> some View {
        fact("Pods", "\(group.count)")
        fact("Complete", "\(Int(Double(group.filter { $0.status == .complete }.count) / Double(max(group.count, 1)) * 100))%")
        fact("Attention", "\(group.filter(DesktopHistoryFilter.needsAttention).count)")
        fact("Avg cost", settled.isEmpty ? "—" : String(format: "$%.2f", settled.reduce(0) { $0 + $1.costUsd } / Double(settled.count)))
        fact("Avg attempts", attempts.isEmpty ? "1.0" : String(format: "%.1f", Double(attempts.reduce(0) { $0 + $1.current }) / Double(attempts.count)))
        fact("Rework", "\(Int(Double(group.filter { ($0.attempts?.current ?? 1) > 1 }.count) / Double(max(group.count, 1)) * 100))%")
    }
}
