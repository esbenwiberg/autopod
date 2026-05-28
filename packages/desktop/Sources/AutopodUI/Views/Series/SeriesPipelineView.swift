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
    public var qualityScores: [String: PodQualityScore]
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
        qualityScores: [String: PodQualityScore] = [:],
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
        self.qualityScores = qualityScores
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
        case summary = "Summary"
        case purpose = "Purpose"
        case design = "Design"
    }

    @State private var panelPodId: String?
    @State private var viewMode: ViewMode = .dag
    @State private var dagSize: CGSize = .zero

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
                Text("Summary").tag(ViewMode.summary)
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
            if showViewModePicker {
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
                case .summary:
                    SeriesSummaryView(pods: pods, qualityScores: qualityScores)
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
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { dagSize = proxy.size }
                        .onChange(of: proxy.size) { _, newSize in dagSize = newSize }
                }
            )
            .overlay(alignment: .topLeading) {
                if dagSize.width > 1 && dagSize.height > 1 {
                    dagCanvasContent(size: dagSize)
                }
            }
    }

    private func dagCanvasContent(size: CGSize) -> some View {
        let sm = fittingMetrics(for: size)
        let inputs = pods.map { PipelineDAGLayout.Input(id: $0.id, parentIds: $0.dependsOnPodIds) }
        let layout = PipelineDAGLayout.layout(inputs, metrics: sm)
        let positions = Dictionary(uniqueKeysWithValues: layout.nodes.map { ($0.id, $0.position) })
        let edges = layout.edges.map { edge in
            PipelineEdgeCanvas.EdgeStyle(
                from: edge.from, to: edge.to,
                color: edgeColor(parent: podsById[edge.from], child: podsById[edge.to])
            )
        }
        let xOff = size.width > layout.width ? (size.width - layout.width) / 2 : 0

        return ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                PipelineEdgeCanvas(
                    edges: edges,
                    nodePositions: positions,
                    nodeSize: CGSize(width: sm.nodeWidth, height: sm.nodeHeight)
                )
                .frame(width: layout.width, height: layout.height)
                .offset(x: xOff, y: 0)

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
                        .position(x: node.position.x + xOff, y: node.position.y)
                    }
                }
            }
            .frame(
                width: max(layout.width, size.width),
                height: layout.height
            )
        }
        .frame(width: size.width, height: size.height)
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

private struct SeriesSummaryView: View {
    let pods: [Pod]
    let qualityScores: [String: PodQualityScore]

    private struct Row: Identifiable {
        let pod: Pod
        let quality: PodQualityScore?

        var id: String { pod.id }
    }

    private var rows: [Row] {
        pods
            .sorted { $0.startedAt < $1.startedAt }
            .map { Row(pod: $0, quality: qualityScores[$0.id]) }
    }

    private var totalCost: Double {
        pods.reduce(0.0) { $0 + $1.costUsd }
    }

    private var totalInputTokens: Int {
        pods.reduce(0) { $0 + $1.inputTokens }
    }

    private var totalOutputTokens: Int {
        pods.reduce(0) { $0 + $1.outputTokens }
    }

    private var totalFiles: Int {
        pods.reduce(0) { $0 + ($1.diffStats?.files ?? 0) }
    }

    private var totalAdded: Int {
        pods.reduce(0) { $0 + ($1.diffStats?.added ?? 0) }
    }

    private var totalRemoved: Int {
        pods.reduce(0) { $0 + ($1.diffStats?.removed ?? 0) }
    }

    private var scoredRows: [Row] {
        rows.filter { $0.quality != nil }
    }

    private var averageQuality: Double? {
        guard !scoredRows.isEmpty else { return nil }
        let total = scoredRows.reduce(0) { $0 + ($1.quality?.score ?? 0) }
        return Double(total) / Double(scoredRows.count)
    }

    private var validationKnownCount: Int {
        rows.filter { validationLabel(for: $0) != "n/a" }.count
    }

    private var validationPassedCount: Int {
        rows.filter { validationLabel(for: $0) == "pass" }.count
    }

    private var validationAttemptCount: Int {
        pods.reduce(0) { $0 + ($1.attempts?.current ?? 0) }
    }

    private var failedCost: Double {
        pods
            .filter { $0.status == .failed || $0.status == .killed }
            .reduce(0.0) { $0 + $1.costUsd }
    }

    private var deliveredCount: Int {
        pods.filter { deliveredStatuses.contains($0.status) }.count
    }

    private let deliveredStatuses: Set<PodStatus> = [
        .validated, .approved, .merging, .mergePending, .complete,
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                metricGrid
                Divider()
                podTable
                if !scoredRows.isEmpty {
                    Divider()
                    qualityBreakdown
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var metricGrid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 150), spacing: 10)],
            alignment: .leading,
            spacing: 10
        ) {
            metricTile(
                icon: "dollarsign.circle",
                label: "Cost",
                value: String(format: "$%.2f", totalCost),
                detail: pods.isEmpty ? "0 pods" : String(format: "$%.2f/pod", totalCost / Double(pods.count)),
                color: totalCost > 50 ? .orange : .green
            )
            metricTile(
                icon: "number",
                label: "Tokens",
                value: formatTokenCount(totalInputTokens + totalOutputTokens),
                detail: "in \(formatTokenCount(totalInputTokens)) / out \(formatTokenCount(totalOutputTokens))",
                color: .blue
            )
            metricTile(
                icon: "checkmark.seal",
                label: "Quality",
                value: averageQuality.map { String(format: "%.0f", $0) } ?? "n/a",
                detail: "\(scoredRows.count)/\(pods.count) scored",
                color: qualityColor(averageQuality.map { Int($0.rounded()) })
            )
            metricTile(
                icon: "checklist.checked",
                label: "Validation",
                value: validationKnownCount == 0 ? "n/a" : "\(validationPassedCount)/\(validationKnownCount)",
                detail: "\(validationAttemptCount) attempts",
                color: validationKnownCount == 0 || validationPassedCount == validationKnownCount ? .green : .orange
            )
            metricTile(
                icon: "doc.on.doc",
                label: "Diff",
                value: "\(totalFiles) files",
                detail: "+\(formatPlainCount(totalAdded)) / -\(formatPlainCount(totalRemoved))",
                color: .purple
            )
            metricTile(
                icon: "flag.checkered",
                label: "Delivery",
                value: "\(deliveredCount)/\(pods.count)",
                detail: statusSummary,
                color: deliveredCount == pods.count ? .green : .blue
            )
            metricTile(
                icon: "exclamationmark.triangle",
                label: "Failed Cost",
                value: String(format: "$%.2f", failedCost),
                detail: "\(pods.filter { $0.status == .failed || $0.status == .killed }.count) pods",
                color: failedCost > 0 ? .red : .secondary
            )
        }
    }

    private var statusSummary: String {
        let running = pods.filter {
            !deliveredStatuses.contains($0.status) && ($0.status.isActive || $0.status.needsAttention)
        }.count
        let queued = pods.filter { $0.status == .queued || $0.status == .paused }.count
        let failed = pods.filter { $0.status == .failed || $0.status == .killed }.count
        return "\(running) running / \(queued) queued / \(failed) failed"
    }

    private func metricTile(
        icon: String,
        label: String,
        value: String,
        detail: String,
        color: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(color)
                    .frame(width: 16)
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value)
                .font(.system(size: 20, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(detail)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(color.opacity(0.2), lineWidth: 1)
        )
    }

    private var podTable: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pods")
                .font(.subheadline.weight(.semibold))
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    tableHeader
                    ForEach(rows) { row in
                        Divider()
                        tableRow(row)
                    }
                }
                .frame(minWidth: 780, alignment: .leading)
            }
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 10) {
            tableText("Pod", width: 220, color: .secondary)
            tableText("Status", width: 100, color: .secondary)
            tableText("Cost", width: 78, color: .secondary, align: .trailing)
            tableText("Tokens", width: 110, color: .secondary, align: .trailing)
            tableText("Quality", width: 70, color: .secondary, align: .trailing)
            tableText("Validation", width: 86, color: .secondary)
            tableText("Diff", width: 110, color: .secondary, align: .trailing)
        }
        .font(.caption.weight(.semibold))
        .padding(.vertical, 4)
    }

    private func tableRow(_ row: Row) -> some View {
        let pod = row.pod
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(pod.briefTitle ?? pod.branch)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(pod.id)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            .frame(width: 220, alignment: .leading)
            statusPill(pod.status)
                .frame(width: 100, alignment: .leading)
            tableText(String(format: "$%.2f", pod.costUsd), width: 78, align: .trailing)
            tableText(
                formatTokenCount(pod.inputTokens + pod.outputTokens),
                width: 110,
                color: .secondary,
                align: .trailing
            )
            qualityPill(row.quality)
                .frame(width: 70, alignment: .trailing)
            tableText(validationLabel(for: row), width: 86, color: validationColor(for: row))
            diffText(pod.diffStats)
                .frame(width: 110, alignment: .trailing)
        }
        .padding(.vertical, 7)
    }

    private func tableText(
        _ text: String,
        width: CGFloat,
        color: Color = .primary,
        align: Alignment = .leading
    ) -> some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(color)
            .lineLimit(1)
            .frame(width: width, alignment: align)
    }

    private func statusPill(_ status: PodStatus) -> some View {
        Text(status.label)
            .font(.system(.caption2).weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(status.color.opacity(0.1))
            .foregroundStyle(status.color)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func qualityPill(_ score: PodQualityScore?) -> some View {
        let value = score.map { "\($0.score)" } ?? "n/a"
        let color = qualityColor(score?.score)
        return HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(value)
                .font(.system(.caption, design: .monospaced))
                .monospacedDigit()
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func diffText(_ diff: DiffStats?) -> some View {
        HStack(spacing: 4) {
            Text("+\(formatPlainCount(diff?.added ?? 0))")
                .foregroundStyle(.green)
            Text("-\(formatPlainCount(diff?.removed ?? 0))")
                .foregroundStyle(.red)
            Text("\(diff?.files ?? 0)f")
                .foregroundStyle(.tertiary)
        }
        .font(.system(.caption, design: .monospaced))
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var qualityBreakdown: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Quality Signals")
                .font(.subheadline.weight(.semibold))
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 150), spacing: 10)],
                alignment: .leading,
                spacing: 10
            ) {
                metricTile(
                    icon: "eye",
                    label: "Reads",
                    value: "\(scoredRows.reduce(0) { $0 + ($1.quality?.readCount ?? 0) })",
                    detail: "\(scoredRows.reduce(0) { $0 + ($1.quality?.editCount ?? 0) }) edits",
                    color: .blue
                )
                metricTile(
                    icon: "wand.and.stars",
                    label: "Blind Edits",
                    value: "\(scoredRows.reduce(0) { $0 + ($1.quality?.editsWithoutPriorRead ?? 0) })",
                    detail: "\(scoredRows.reduce(0) { $0 + ($1.quality?.editChurnCount ?? 0) }) churn files",
                    color: .orange
                )
                metricTile(
                    icon: "person.crop.circle.badge.exclamationmark",
                    label: "Interrupts",
                    value: "\(scoredRows.reduce(0) { $0 + ($1.quality?.userInterrupts ?? 0) })",
                    detail: "\(scoredRows.reduce(0) { $0 + ($1.quality?.prFixAttempts ?? 0) }) PR fixes",
                    color: .red
                )
            }
        }
    }

    private func validationLabel(for row: Row) -> String {
        if row.pod.validationChecks?.allPassed == true { return "pass" }
        if row.pod.validationChecks != nil { return "fail" }
        if row.quality?.validationPassed == true { return "pass" }
        if row.quality?.validationPassed == false { return "fail" }
        return "n/a"
    }

    private func validationColor(for row: Row) -> Color {
        switch validationLabel(for: row) {
        case "pass": return .green
        case "fail": return .red
        default: return .secondary
        }
    }

    private func qualityColor(_ score: Int?) -> Color {
        guard let score else { return .secondary }
        switch score {
        case 80...: return .green
        case 60..<80: return .yellow
        default: return .red
        }
    }

    private func formatTokenCount(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return String(format: "%.1fK", Double(count) / 1_000) }
        return "\(count)"
    }

    private func formatPlainCount(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return String(format: "%.1fK", Double(count) / 1_000) }
        return "\(count)"
    }
}
