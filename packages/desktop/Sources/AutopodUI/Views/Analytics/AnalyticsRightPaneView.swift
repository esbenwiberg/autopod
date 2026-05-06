import SwiftUI
import AutopodClient

/// Right-pane host for Analytics drill-in content.
///
/// - When `card == nil`: renders a centered empty state.
/// - When `card != nil`: renders the corresponding drill subview.
///
/// This view is a pure function of its inputs — no `@State`, no `@StateObject`.
public struct AnalyticsRightPaneView: View {
    public let card: AnalyticsCardKind?
    public let pods: [Pod]
    public let loadScores: (() async throws -> [PodQualityScore])?
    public let loadCost: (() async throws -> CostAnalyticsResponse)?
    public let loadReliability: (() async throws -> ReliabilityAnalyticsResponse)?
    public let onSelectPod: ((String) -> Void)?

    public init(
        card: AnalyticsCardKind?,
        pods: [Pod],
        loadScores: (() async throws -> [PodQualityScore])? = nil,
        loadCost: (() async throws -> CostAnalyticsResponse)? = nil,
        loadReliability: (() async throws -> ReliabilityAnalyticsResponse)? = nil,
        onSelectPod: ((String) -> Void)? = nil
    ) {
        self.card = card
        self.pods = pods
        self.loadScores = loadScores
        self.loadCost = loadCost
        self.loadReliability = loadReliability
        self.onSelectPod = onSelectPod
    }

    public var body: some View {
        switch card {
        case .cost:
            CostDrillView(loadCost: loadCost, onSelectPod: onSelectPod)
        case .quality:
            QualityDrillView(pods: pods, loadScores: loadScores, onSelectPod: onSelectPod)
        case .status:
            StatusDrillView(pods: pods)
        case .reliability:
            ReliabilityDrillView(loadReliability: loadReliability, onSelectPod: onSelectPod)
        case .none:
            VStack(spacing: 8) {
                Spacer()
                Image(systemName: "chart.bar.xaxis")
                    .font(.system(size: 48, weight: .thin))
                    .foregroundStyle(.tertiary)
                Text("Click a card to drill in")
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Preview

#Preview("AnalyticsRightPaneView — empty state") {
    AnalyticsRightPaneView(card: nil, pods: [])
        .frame(width: 300, height: 400)
}

#Preview("AnalyticsRightPaneView — cost drill") {
    AnalyticsRightPaneView(card: .cost, pods: MockData.all)
        .frame(width: 300, height: 400)
}

#Preview("AnalyticsRightPaneView — status drill") {
    AnalyticsRightPaneView(card: .status, pods: MockData.all)
        .frame(width: 300, height: 400)
}
