import SwiftUI

/// Top-level DAG view for a pod series. Renders nodes via `PipelineNodeView`,
/// edges via `PipelineEdgeCanvas`, and a status/cost footer.
///
/// The view is a pure projection of `pods` — it re-renders whenever any pod's
/// status or cost changes. No polling, no local state for pod contents.
public struct SeriesPipelineView: View {
    public let pods: [Pod]
    public let selectedPodId: String?
    public let onSelectPod: (String) -> Void

    public init(
        pods: [Pod],
        selectedPodId: String? = nil,
        onSelectPod: @escaping (String) -> Void = { _ in }
    ) {
        self.pods = pods
        self.selectedPodId = selectedPodId
        self.onSelectPod = onSelectPod
    }

    private let metrics = PipelineDAGLayout.Metrics.default

    private var podsById: [String: Pod] {
        Dictionary(uniqueKeysWithValues: pods.map { ($0.id, $0) })
    }

    private var layoutResult: PipelineDAGLayout.Result {
        let inputs = pods.map {
            PipelineDAGLayout.Input(id: $0.id, parentIds: $0.dependsOnPodIds)
        }
        return PipelineDAGLayout.layout(inputs, metrics: metrics)
    }

    private var edgeStyles: [PipelineEdgeCanvas.EdgeStyle] {
        let layout = layoutResult
        return layout.edges.map { edge in
            let parent = podsById[edge.from]
            let child = podsById[edge.to]
            return PipelineEdgeCanvas.EdgeStyle(
                from: edge.from,
                to: edge.to,
                color: edgeColor(parent: parent, child: child)
            )
        }
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

    private var nodePositions: [String: CGPoint] {
        Dictionary(uniqueKeysWithValues: layoutResult.nodes.map { ($0.id, $0.position) })
    }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView([.horizontal, .vertical]) {
                let layout = layoutResult
                ZStack(alignment: .topLeading) {
                    PipelineEdgeCanvas(
                        edges: edgeStyles,
                        nodePositions: nodePositions,
                        nodeSize: CGSize(width: metrics.nodeWidth, height: metrics.nodeHeight)
                    )
                    .frame(width: layout.width, height: layout.height)

                    ForEach(layout.nodes, id: \.id) { node in
                        if let pod = podsById[node.id] {
                            PipelineNodeView(
                                pod: pod,
                                isSelected: selectedPodId == pod.id,
                                onTap: { onSelectPod(pod.id) }
                            )
                            .frame(width: metrics.nodeWidth, height: metrics.nodeHeight)
                            .position(x: node.position.x, y: node.position.y)
                        }
                    }
                }
                .frame(width: layoutResult.width, height: layoutResult.height)
            }
            Divider()
            footer
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
