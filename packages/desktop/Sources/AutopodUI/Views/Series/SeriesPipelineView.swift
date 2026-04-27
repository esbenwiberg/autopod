import AutopodClient
import MarkdownUI
import SwiftUI

/// Top-level DAG view for a pod series. Renders nodes via `PipelineNodeView`,
/// edges via `PipelineEdgeCanvas`, and a status/cost footer.
///
/// The view is a pure projection of `pods` — it re-renders whenever any pod's
/// status or cost changes. No polling, no local state for pod contents.
///
/// When `panelEnabled` is true, tapping a node slides in a `PodActivityPanel`
/// on the right instead of calling `onSelectPod` directly. A navigate button
/// in the panel calls `onSelectPod`.
public struct SeriesPipelineView: View {
    public let pods: [Pod]
    public let selectedPodId: String?
    public let onSelectPod: (String) -> Void
    /// When true, tapping a node opens the slide-in activity panel instead of
    /// immediately navigating via `onSelectPod`.
    public var panelEnabled: Bool
    public var actions: PodActions
    /// Returns the agent event stream for the pod opened in the slide-in panel.
    /// Only invoked when `panelEnabled` is true. Closure form (rather than a passed-in
    /// dict) so SwiftUI doesn't observe the entire `EventStream.sessionEvents` map.
    public var eventsForPod: ((String) -> [AgentEvent])?
    /// Triggers a historical event fetch for `panelPodId` when the panel opens
    /// a sibling pod whose events haven't been loaded yet.
    public var loadEventsForPod: ((String) -> Void)?
    /// Quality-signals fetcher passed through to the slide-in panel.
    public var loadQuality: ((String) async throws -> PodQualitySignals)?
    /// Lets the slide-in panel switch the main detail to a specific tab
    /// (e.g. "Full validation →").
    public var requestTab: ((DetailTab) -> Void)?
    /// When false the Purpose/Design view-mode picker is hidden (e.g. inline DAG in SeriesListView).
    public var showViewModePicker: Bool

    public init(
        pods: [Pod],
        selectedPodId: String? = nil,
        onSelectPod: @escaping (String) -> Void = { _ in },
        panelEnabled: Bool = false,
        actions: PodActions = .preview,
        eventsForPod: ((String) -> [AgentEvent])? = nil,
        loadEventsForPod: ((String) -> Void)? = nil,
        loadQuality: ((String) async throws -> PodQualitySignals)? = nil,
        requestTab: ((DetailTab) -> Void)? = nil,
        showViewModePicker: Bool = true
    ) {
        self.pods = pods
        self.selectedPodId = selectedPodId
        self.onSelectPod = onSelectPod
        self.panelEnabled = panelEnabled
        self.actions = actions
        self.eventsForPod = eventsForPod
        self.loadEventsForPod = loadEventsForPod
        self.loadQuality = loadQuality
        self.requestTab = requestTab
        self.showViewModePicker = showViewModePicker
    }

    private enum ViewMode: String {
        case dag = "Pipeline"
        case purpose = "Purpose"
        case design = "Design"
    }

    @State private var panelPodId: String?
    @State private var viewMode: ViewMode = .dag

    private var podsById: [String: Pod] {
        Dictionary(uniqueKeysWithValues: pods.map { ($0.id, $0) })
    }

    private var seriesDescription: String? {
        pods.first(where: { $0.seriesDescription?.isEmpty == false })?.seriesDescription
    }

    private var seriesDesign: String? {
        pods.first(where: { $0.seriesDesign?.isEmpty == false })?.seriesDesign
    }

    private func edgeColor(parent: Pod?, child: Pod?) -> Color {
        guard let parent else { return .gray }
        if parent.status == .failed || parent.status == .killed { return .red }
        if child?.status == .queued { return .gray.opacity(0.6) }
        if parent.status == .validated
            || parent.status == .approved
            || parent.status == .merging
            || parent.status == .mergePending
            || parent.status == .complete {
            return .green
        }
        return .gray.opacity(0.8)
    }

    private var viewModePicker: some View {
        HStack {
            Picker("", selection: $viewMode) {
                Text("Pipeline").tag(ViewMode.dag)
                if seriesDescription != nil { Text("Purpose").tag(ViewMode.purpose) }
                if seriesDesign != nil { Text("Design").tag(ViewMode.design) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func markdownView(_ text: String) -> some View {
        ScrollView(.vertical) {
            Markdown(text)
                .markdownTheme(.autopod)
                .textSelection(.enabled)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            if showViewModePicker && (seriesDescription != nil || seriesDesign != nil) {
                viewModePicker
                Divider()
            }
            Group {
                switch viewMode {
                case .dag:
                    HStack(spacing: 0) {
                        dagCanvas
                        if panelEnabled, let pid = panelPodId, let pod = podsById[pid] {
                            Divider()
                            PodActivityPanel(
                                pod: pod,
                                events: eventsForPod?(pod.id) ?? [],
                                actions: actions,
                                onNavigate: {
                                    panelPodId = nil
                                    onSelectPod(pod.id)
                                },
                                loadQuality: loadQuality,
                                requestTab: requestTab
                            )
                            .frame(width: 380)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                        }
                    }
                    .animation(.easeOut(duration: 0.18), value: panelPodId)
                    .onChange(of: panelPodId) { _, newId in
                        if let id = newId { loadEventsForPod?(id) }
                    }
                case .purpose:
                    markdownView(seriesDescription ?? "")
                case .design:
                    markdownView(seriesDesign ?? "")
                }
            }
            Divider()
            footer
        }
        .onChange(of: pods.first?.seriesId) { viewMode = .dag }
    }

    private func fittingMetrics(for size: CGSize) -> PipelineDAGLayout.Metrics {
        let base = PipelineDAGLayout.Metrics.default
        guard size.width > 0, size.height > 0, !pods.isEmpty else { return base }

        let inputs = pods.map { PipelineDAGLayout.Input(id: $0.id, parentIds: $0.dependsOnPodIds) }

        // How many columns fit in the available width at default node size?
        let startCols = max(1, Int(
            (size.width - 2 * base.paddingX + base.horizontalGap)
                / (base.nodeWidth + base.horizontalGap)
        ))

        // Find the fewest columns that keeps scale >= 0.7 (wider layout = fewer rows = shorter height).
        // Iterates from startCols upward until the layout fits or we exhaust all columns (single row).
        var chosenMetrics = base
        chosenMetrics.maxColumns = startCols

        let maxIter = max(startCols, inputs.count)
        for cols in startCols...maxIter {
            var m = base
            m.maxColumns = cols
            let lo = PipelineDAGLayout.layout(inputs, metrics: m)
            guard lo.width > 0, lo.height > 0 else { continue }

            let scale = min(size.height / lo.height, size.width / lo.width)
            let s = min(max(scale, 0.7), 3.0)

            chosenMetrics = PipelineDAGLayout.Metrics(
                nodeWidth:     base.nodeWidth     * s,
                nodeHeight:    base.nodeHeight    * s,
                horizontalGap: base.horizontalGap * s,
                verticalGap:   base.verticalGap   * s,
                paddingX:      base.paddingX      * s,
                paddingY:      base.paddingY      * s,
                maxColumns:    cols
            )

            if scale >= 0.7 { break }
        }

        return chosenMetrics
    }

    private var dagCanvas: some View {
        GeometryReader { geo in
            let sm = fittingMetrics(for: geo.size)
            let inputs = pods.map { PipelineDAGLayout.Input(id: $0.id, parentIds: $0.dependsOnPodIds) }
            let layout = PipelineDAGLayout.layout(inputs, metrics: sm)
            let positions = Dictionary(uniqueKeysWithValues: layout.nodes.map { ($0.id, $0.position) })
            let edges = layout.edges.map { edge in
                PipelineEdgeCanvas.EdgeStyle(
                    from: edge.from, to: edge.to,
                    color: edgeColor(parent: podsById[edge.from], child: podsById[edge.to])
                )
            }
            let xOff = geo.size.width > layout.width ? (geo.size.width - layout.width) / 2 : 0
            let yOff = geo.size.height > layout.height ? (geo.size.height - layout.height) / 2 : 0

            ScrollView([.horizontal, .vertical]) {
                ZStack(alignment: .topLeading) {
                    PipelineEdgeCanvas(
                        edges: edges,
                        nodePositions: positions,
                        nodeSize: CGSize(width: sm.nodeWidth, height: sm.nodeHeight)
                    )
                    .frame(width: layout.width, height: layout.height)
                    .offset(x: xOff, y: yOff)

                    ForEach(layout.nodes, id: \.id) { node in
                        if let pod = podsById[node.id] {
                            PipelineNodeView(
                                pod: pod,
                                isSelected: panelEnabled ? panelPodId == pod.id : selectedPodId == pod.id,
                                onTap: {
                                    if panelEnabled {
                                        panelPodId = panelPodId == pod.id ? nil : pod.id
                                    } else {
                                        onSelectPod(pod.id)
                                    }
                                }
                            )
                            .frame(width: sm.nodeWidth, height: sm.nodeHeight)
                            .position(x: node.position.x + xOff, y: node.position.y + yOff)
                        }
                    }
                }
                .frame(
                    width: max(layout.width, geo.size.width),
                    height: max(layout.height, geo.size.height)
                )
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        let counts = statusCounts(pods)
        let totalCost = pods.reduce(0.0) { $0 + $1.costUsd }
        let est = estimatedMinutesLeft()
        return HStack(spacing: 16) {
            footerChip("\(counts.validated) validated", color: .secondary)
            footerChip("\(counts.running) running", color: .blue)
            footerChip("\(counts.queued) queued", color: .gray)
            if counts.failed > 0 {
                footerChip("\(counts.failed) failed", color: .red)
            }
            Spacer()
            Text(String(format: "$%.2f", totalCost))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            if let est {
                Text("est. \(est)m left")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    private func footerChip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(.caption2).weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private struct Counts {
        var validated = 0
        var running = 0
        var queued = 0
        var failed = 0
    }

    private func statusCounts(_ pods: [Pod]) -> Counts {
        var c = Counts()
        for pod in pods {
            switch pod.status {
            case .validated, .approved, .merging, .mergePending, .complete:
                c.validated += 1
            case .provisioning, .running, .validating, .handoff, .awaitingInput:
                c.running += 1
            case .queued, .paused:
                c.queued += 1
            case .failed, .killed, .reviewRequired, .killing:
                c.failed += 1
            }
        }
        return c
    }

    /// Rough time-left estimate: average duration of validated pods × pods
    /// not yet done. Intentionally conservative and ignores concurrency.
    private func estimatedMinutesLeft() -> Int? {
        let done = pods.filter {
            [.validated, .approved, .merging, .mergePending, .complete].contains($0.status)
        }
        guard !done.isEmpty else { return nil }
        let avgSeconds = done.reduce(0.0) { acc, pod in
            acc + Date().timeIntervalSince(pod.startedAt)
        } / Double(done.count)
        let remaining = pods.filter {
            $0.status == .queued || $0.status == .running
                || $0.status == .provisioning || $0.status == .validating
        }.count
        guard remaining > 0 else { return nil }
        let minutes = Int((avgSeconds * Double(remaining)) / 60.0)
        return max(1, minutes)
    }
}
