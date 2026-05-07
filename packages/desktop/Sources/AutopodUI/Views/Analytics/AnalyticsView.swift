import AutopodClient
import SwiftUI

// MARK: - AnalyticsView (Overview card grid)

/// Analytics Overview — three clickable cards in the middle pane.
/// Drill-in content is rendered by `AnalyticsRightPaneView` when a card is
/// selected. `selectedCard` is held as `@State` in `MainView` so the selection
/// persists across sidebar navigation.
public struct AnalyticsView: View {
    public let pods: [Pod]
    /// Fetches persisted quality scores for the Quality card value.
    public var loadScores: (() async throws -> [PodQualityScore])?
    /// Fetches cost analytics from the daemon for the Cost card.
    public var loadCost: (() async throws -> CostAnalyticsResponse)?
    /// Fetches reliability analytics from the daemon for the Reliability card.
    public var loadReliability: (() async throws -> ReliabilityAnalyticsResponse)?
    /// Fetches quality analytics from the daemon for the Quality card (sparkline, delta, sub-line).
    public var loadQualityAnalytics: ((Int) async throws -> QualityAnalyticsResponse)?
    /// Fetches safety analytics from the daemon for the Safety card (sparkline, delta, sub-line).
    public var loadSafetyAnalytics: ((Int) async throws -> SafetyAnalyticsResponse)?
    @Binding public var selectedCard: AnalyticsCardKind?

    @State private var scores: [PodQualityScore] = []
    @State private var scoresLoadError: String?
    @State private var costData: CostAnalyticsResponse?
    @State private var costLoadError: String?
    @State private var reliabilityData: ReliabilityAnalyticsResponse?
    @State private var reliabilityLoadError: String?
    @State private var qualityData: QualityAnalyticsResponse?
    @State private var qualityLoadError: String?
    @State private var safetyData: SafetyAnalyticsResponse?
    @State private var safetyLoadError: String?

    public init(
        pods: [Pod],
        loadScores: (() async throws -> [PodQualityScore])? = nil,
        loadCost: (() async throws -> CostAnalyticsResponse)? = nil,
        loadReliability: (() async throws -> ReliabilityAnalyticsResponse)? = nil,
        loadQualityAnalytics: ((Int) async throws -> QualityAnalyticsResponse)? = nil,
        loadSafetyAnalytics: ((Int) async throws -> SafetyAnalyticsResponse)? = nil,
        selectedCard: Binding<AnalyticsCardKind?> = .constant(nil)
    ) {
        self.pods = pods
        self.loadScores = loadScores
        self.loadCost = loadCost
        self.loadReliability = loadReliability
        self.loadQualityAnalytics = loadQualityAnalytics
        self.loadSafetyAnalytics = loadSafetyAnalytics
        self._selectedCard = selectedCard
    }

    // MARK: - Computed stats (card values)

    private var statusCounts: [StatusCount] {
        analyticsStatusCounts(pods: pods)
    }

    private var avgQualityValue: String {
        if let q = qualityData { return "\(Int(q.summary.avgScore.rounded()))" }
        if qualityLoadError != nil { return "Error" }
        if scoresLoadError != nil { return "Error" }
        guard !scores.isEmpty else { return "—" }
        let total = scores.reduce(0) { $0 + $1.score }
        return "\(Int((Double(total) / Double(scores.count)).rounded()))"
    }

    private var qualityCardSparkline: [Double]? {
        qualityData.map { $0.sparkline.map(\.avgScore) }
    }

    private var qualityCardDelta: AnalyticsCardDelta? {
        qualityData.map {
            AnalyticsCardDelta(
                value: String(format: "%+.0fpp", $0.summary.deltaVsPrior.value),
                direction: AnalyticsCardDelta.Direction($0.summary.deltaVsPrior.direction)
            )
        }
    }

    private var qualityCardSubline: String? {
        guard let q = qualityData, q.summary.redCount > 0 else { return nil }
        return "\(q.summary.redCount) red pod\(q.summary.redCount == 1 ? "" : "s")"
    }

    private var costCardValue: String {
        costData.map { String(format: "$%.2f", $0.total) } ?? "—"
    }

    /// Non-nil only when there is actual data in the window; nil means "no data" (show "—").
    private var reliabilityDataIfPopulated: ReliabilityAnalyticsResponse? {
        reliabilityData.flatMap { $0.summary.totalPodsInWindow > 0 ? $0 : nil }
    }

    private var reliabilityCardValue: String {
        reliabilityDataIfPopulated.map { String(format: "%.0f%%", $0.firstPassRate * 100) } ?? "—"
    }

    private var dominantStatusValue: String {
        guard let top = statusCounts.max(by: { $0.count < $1.count }) else { return "—" }
        return "\(top.count) \(top.status.label)"
    }

    private var safetyCardValue: String {
        safetyData.map { String($0.summary.totalEvents) } ?? "—"
    }

    private var safetyCardSparkline: [Double]? {
        safetyData.map { $0.summary.sparkline.map { Double($0.count) } }
    }

    private var safetyCardDelta: AnalyticsCardDelta? {
        safetyData.map {
            AnalyticsCardDelta(
                value: String(format: "%+d", $0.summary.deltaVsPrior.value),
                direction: AnalyticsCardDelta.Direction($0.summary.deltaVsPrior.direction)
            )
        }
    }

    private var safetyCardSubline: String? {
        guard let s = safetyData,
              s.summary.totalEvents > 0 || s.summary.quarantineCount > 0 else { return nil }
        let piiCount = s.summary.byKind.pii
        let quarantineCount = s.summary.quarantineCount
        let injectionCount = s.summary.byKind.injection
        return "\(piiCount) PII \u{00B7} \(quarantineCount) quar \u{00B7} \(injectionCount) inj"
    }

    // MARK: - Body

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Overview")
                    .font(.title2.weight(.semibold))

                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 280), spacing: 12)],
                    spacing: 12
                ) {
                    AnalyticsCard(
                        title: "Cost",
                        value: costCardValue,
                        sparkline: costData.map { $0.sparkline.map(\.costUsd) },
                        delta: costData.map {
                            AnalyticsCardDelta(
                                value: formatCostDelta($0.deltaVsPrior),
                                direction: AnalyticsCardDelta.Direction($0.deltaVsPrior.direction)
                            )
                        },
                        isSelected: selectedCard == .cost,
                        onClick: { selectedCard = selectedCard == .cost ? nil : .cost }
                    )
                    AnalyticsCard(
                        title: "Quality",
                        value: avgQualityValue,
                        sparkline: qualityCardSparkline,
                        delta: qualityCardDelta,
                        subline: qualityCardSubline,
                        isSelected: selectedCard == .quality,
                        onClick: { selectedCard = selectedCard == .quality ? nil : .quality }
                    )
                    AnalyticsCard(
                        title: "Status",
                        value: dominantStatusValue,
                        isSelected: selectedCard == .status,
                        onClick: { selectedCard = selectedCard == .status ? nil : .status }
                    )
                    AnalyticsCard(
                        title: "Reliability",
                        value: reliabilityCardValue,
                        sparkline: reliabilityDataIfPopulated.map { $0.firstPassRateSparkline.map(\.rate) },
                        delta: reliabilityDataIfPopulated.map {
                            AnalyticsCardDelta(
                                value: String(format: "%+.1fpp", $0.firstPassRateDelta.value),
                                direction: AnalyticsCardDelta.Direction($0.firstPassRateDelta.direction)
                            )
                        },
                        isSelected: selectedCard == .reliability,
                        onClick: { selectedCard = selectedCard == .reliability ? nil : .reliability }
                    )
                    AnalyticsCard(
                        title: "Safety",
                        value: safetyCardValue,
                        sparkline: safetyCardSparkline,
                        delta: safetyCardDelta,
                        subline: safetyCardSubline,
                        isSelected: selectedCard == .safety,
                        onClick: { selectedCard = selectedCard == .safety ? nil : .safety }
                    )
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            // All fetches are independent — kick off concurrently and await all.
            let scoreTask = Task {
                if let loadScores {
                    do {
                        scores = try await loadScores()
                        scoresLoadError = nil
                    } catch {
                        scoresLoadError = error.localizedDescription
                    }
                }
            }
            let costTask = Task {
                if let loadCost {
                    do {
                        costData = try await loadCost()
                        costLoadError = nil
                    } catch {
                        costLoadError = error.localizedDescription
                    }
                }
            }
            let reliabilityTask = Task {
                if let loadReliability {
                    do {
                        reliabilityData = try await loadReliability()
                        reliabilityLoadError = nil
                    } catch {
                        reliabilityLoadError = error.localizedDescription
                    }
                }
            }
            let qualityTask = Task {
                if let loadQualityAnalytics {
                    do {
                        qualityData = try await loadQualityAnalytics(30)
                        qualityLoadError = nil
                    } catch {
                        qualityLoadError = error.localizedDescription
                    }
                }
            }
            let safetyTask = Task {
                if let loadSafetyAnalytics {
                    do {
                        safetyData = try await loadSafetyAnalytics(30)
                        safetyLoadError = nil
                    } catch {
                        safetyLoadError = error.localizedDescription
                    }
                }
            }
            await scoreTask.value
            await costTask.value
            await reliabilityTask.value
            await qualityTask.value
            await safetyTask.value
        }
    }
}

// MARK: - StatusDrillView

/// Expanded status proportion bar + row-style legend — right-pane drill for the Status card.
struct StatusDrillView: View {
    let pods: [Pod]

    private var statusCounts: [StatusCount] { analyticsStatusCounts(pods: pods) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Status Distribution")
                    .font(.title3.weight(.semibold))

                if statusCounts.isEmpty {
                    Text("No pod data available yet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                } else {
                    proportionBar
                    Divider()
                    legendRows
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var proportionBar: some View {
        let total = statusCounts.reduce(0) { $0 + $1.count }
        return GeometryReader { geo in
            HStack(spacing: 1) {
                ForEach(statusCounts) { item in
                    let fraction = CGFloat(item.count) / CGFloat(max(total, 1))
                    RoundedRectangle(cornerRadius: 2)
                        .fill(item.status.color)
                        .frame(width: max(fraction * geo.size.width - 1, 4))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .frame(height: 12)
    }

    private var legendRows: some View {
        let lastId = statusCounts.last?.id
        return VStack(spacing: 0) {
            ForEach(statusCounts) { item in
                HStack(spacing: 10) {
                    Circle()
                        .fill(item.status.color)
                        .frame(width: 10, height: 10)
                    Text(item.status.label)
                        .font(.body)
                    Spacer()
                    Text("\(item.count)")
                        .font(.system(.body, design: .monospaced).weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 4)
                if item.id != lastId {
                    Divider()
                }
            }
        }
    }
}

// MARK: - Cost delta helpers

private func formatCostDelta(_ delta: CostDelta) -> String {
    switch delta.direction {
    case .flat: return "flat"
    case .up:   return String(format: "+$%.2f", delta.value)
    case .down: return String(format: "-$%.2f", abs(delta.value))
    }
}

extension AnalyticsCardDelta.Direction {
    init(_ direction: CostDelta.Direction) {
        switch direction {
        case .up:   self = .up
        case .down: self = .down
        case .flat: self = .flat
        }
    }

    init(_ direction: ReliabilityDelta.Direction) {
        switch direction {
        case .up:   self = .up
        case .down: self = .down
        case .flat: self = .flat
        }
    }

    init(_ direction: QualityDelta.Direction) {
        switch direction {
        case .up:   self = .up
        case .down: self = .down
        case .flat: self = .flat
        }
    }

    init(_ direction: SafetyDelta.Direction) {
        switch direction {
        case .up:   self = .up
        case .down: self = .down
        case .flat: self = .flat
        }
    }
}

// MARK: - File-level helpers (shared by drill views)

// Cached formatters — ISO8601DateFormatter and DateFormatter are expensive to allocate.
// `nonisolated(unsafe)` because Foundation documents these as thread-safe after configuration.
nonisolated(unsafe) private let _isoFullFmt: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
nonisolated(unsafe) private let _isoBasicFmt = ISO8601DateFormatter()
private let _dayFmt: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    return f
}()
nonisolated(unsafe) private let _relFmt: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f
}()

private func analyticsParseDate(_ s: String) -> Date {
    _isoFullFmt.date(from: s) ?? _isoBasicFmt.date(from: s) ?? Date.distantPast
}

private func analyticsStatusCounts(pods: [Pod]) -> [StatusCount] {
    let relevantStatuses: [PodStatus] = [
        .complete, .failed, .reviewRequired, .running, .validated,
        .validating, .awaitingInput, .killed, .queued, .provisioning,
    ]
    return relevantStatuses.compactMap { status in
        let count = pods.filter { $0.status == status }.count
        guard count > 0 else { return nil }
        return StatusCount(status: status, count: count)
    }
}

func analyticsScoreColor(_ score: Int) -> Color {
    switch score {
    case 80...: return .green
    case 60..<80: return .yellow
    default: return .red
    }
}

func analyticsRelativeDate(_ iso: String) -> String {
    let date = analyticsParseDate(iso)
    guard date != Date.distantPast else { return iso }
    return _relFmt.localizedString(for: date, relativeTo: Date())
}

private func analyticsDailyAverages(for group: [PodQualityScore]) -> [Double] {
    let cutoff = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
    let recent = group.filter { analyticsParseDate($0.completedAt) >= cutoff }
    let byDay = Dictionary(grouping: recent) { _dayFmt.string(from: analyticsParseDate($0.completedAt)) }
    return byDay.keys.sorted().compactMap { day -> Double? in
        guard let g = byDay[day], !g.isEmpty else { return nil }
        return Double(g.reduce(0) { $0 + $1.score }) / Double(g.count)
    }
}

// MARK: - Supporting types

struct StatusCount: Identifiable {
    let status: PodStatus
    let count: Int
    var id: String { status.rawValue }
}

struct RuntimeModelStat: Identifiable {
    let runtime: String
    let model: String
    let count: Int
    let avgScore: Double
    let avgCost: Double
    let dailyAverages: [Double]
    var id: String { "\(runtime)/\(model)" }
}

// MARK: - SparklineView

/// Mini line chart — path-based, no axes or labels.
private struct SparklineView: View {
    let values: [Double]
    let color: Color

    var body: some View {
        GeometryReader { geo in
            let min = values.min() ?? 0
            let max = values.max() ?? 1
            let range = max - min > 0 ? max - min : 1
            let w = geo.size.width
            let h = geo.size.height
            let step = w / CGFloat(values.count - 1)

            ZStack(alignment: .bottomLeading) {
                Path { path in
                    path.move(to: CGPoint(x: 0, y: h))
                    for (i, v) in values.enumerated() {
                        let x = CGFloat(i) * step
                        let y = h - CGFloat((v - min) / range) * h
                        if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                        else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                    path.addLine(to: CGPoint(x: w, y: h))
                    path.closeSubpath()
                }
                .fill(color.opacity(0.12))

                Path { path in
                    for (i, v) in values.enumerated() {
                        let x = CGFloat(i) * step
                        let y = h - CGFloat((v - min) / range) * h
                        if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                        else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                }
                .stroke(color.opacity(0.6), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            }
        }
    }
}

// MARK: - Preview

#Preview("Analytics Overview") {
    AnalyticsView(pods: MockData.all)
        .frame(width: 700, height: 400)
}
