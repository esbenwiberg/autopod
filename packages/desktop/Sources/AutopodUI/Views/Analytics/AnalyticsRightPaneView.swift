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
    public let loadQuality: ((Int) async throws -> QualityAnalyticsResponse)?
    public let loadSafety: ((Int) async throws -> SafetyAnalyticsResponse)?
    public let loadThroughput: ((Int) async throws -> ThroughputAnalyticsResponse)?
    public let loadEscalations: ((Int) async throws -> EscalationsAnalyticsResponse)?
    public let verifyAuditChain: (() async throws -> AuditChainVerifyResponse)?
    public let onSelectPod: ((String) -> Void)?
    /// Quality-specific pod selection callback. When provided, used instead of
    /// `onSelectPod` for the Quality drill so callers can apply Quality-only
    /// side-effects (e.g. setting a focused detail tab) without affecting
    /// Cost / Reliability row clicks.
    public let onQualitySelectPod: ((String) -> Void)?
    public let onSafetySelectPod: ((String) -> Void)?
    public let onThroughputSelectPod: ((String) -> Void)?
    public let onEscalationsSelectPod: ((String) -> Void)?

    public init(
        card: AnalyticsCardKind?,
        pods: [Pod],
        loadScores: (() async throws -> [PodQualityScore])? = nil,
        loadCost: (() async throws -> CostAnalyticsResponse)? = nil,
        loadReliability: (() async throws -> ReliabilityAnalyticsResponse)? = nil,
        loadQuality: ((Int) async throws -> QualityAnalyticsResponse)? = nil,
        loadSafety: ((Int) async throws -> SafetyAnalyticsResponse)? = nil,
        loadThroughput: ((Int) async throws -> ThroughputAnalyticsResponse)? = nil,
        loadEscalations: ((Int) async throws -> EscalationsAnalyticsResponse)? = nil,
        verifyAuditChain: (() async throws -> AuditChainVerifyResponse)? = nil,
        onSelectPod: ((String) -> Void)? = nil,
        onQualitySelectPod: ((String) -> Void)? = nil,
        onSafetySelectPod: ((String) -> Void)? = nil,
        onThroughputSelectPod: ((String) -> Void)? = nil,
        onEscalationsSelectPod: ((String) -> Void)? = nil
    ) {
        self.card = card
        self.pods = pods
        self.loadScores = loadScores
        self.loadCost = loadCost
        self.loadReliability = loadReliability
        self.loadQuality = loadQuality
        self.loadSafety = loadSafety
        self.loadThroughput = loadThroughput
        self.loadEscalations = loadEscalations
        self.verifyAuditChain = verifyAuditChain
        self.onSelectPod = onSelectPod
        self.onQualitySelectPod = onQualitySelectPod
        self.onSafetySelectPod = onSafetySelectPod
        self.onThroughputSelectPod = onThroughputSelectPod
        self.onEscalationsSelectPod = onEscalationsSelectPod
    }

    public var body: some View {
        switch card {
        case .cost:
            CostDrillView(loadCost: loadCost, onSelectPod: onSelectPod)
        case .quality:
            if let loadQuality {
                QualityDrillView(load: loadQuality, onSelectPod: onQualitySelectPod ?? onSelectPod)
            } else {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "speedometer")
                        .font(.system(size: 48, weight: .thin))
                        .foregroundStyle(.tertiary)
                    Text("Quality analytics not available")
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .status:
            StatusDrillView(pods: pods)
        case .reliability:
            ReliabilityDrillView(loadReliability: loadReliability, onSelectPod: onSelectPod)
        case .safety:
            SafetyDrillView(
                load: loadSafety,
                verifyAuditChain: verifyAuditChain,
                onSelectPod: onSafetySelectPod ?? onSelectPod
            )
        case .throughput:
            ThroughputDrillView(
                load: loadThroughput,
                onSelectPod: onThroughputSelectPod ?? onSelectPod
            )
        case .escalations:
            EscalationsDrillView(
                load: loadEscalations,
                onSelectPod: onEscalationsSelectPod ?? onSelectPod
            )
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
