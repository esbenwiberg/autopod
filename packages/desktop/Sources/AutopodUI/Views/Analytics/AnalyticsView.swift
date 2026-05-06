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
    @Binding public var selectedCard: AnalyticsCardKind?

    @State private var scores: [PodQualityScore] = []
    @State private var scoresLoadError: String?
    @State private var costData: CostAnalyticsResponse?
    @State private var costLoadError: String?

    public init(
        pods: [Pod],
        loadScores: (() async throws -> [PodQualityScore])? = nil,
        loadCost: (() async throws -> CostAnalyticsResponse)? = nil,
        selectedCard: Binding<AnalyticsCardKind?> = .constant(nil)
    ) {
        self.pods = pods
        self.loadScores = loadScores
        self.loadCost = loadCost
        self._selectedCard = selectedCard
    }

    // MARK: - Computed stats (card values)

    private var statusCounts: [StatusCount] {
        analyticsStatusCounts(pods: pods)
    }

    private var avgQualityValue: String {
        if scoresLoadError != nil { return "Error" }
        guard !scores.isEmpty else { return "—" }
        let total = scores.reduce(0) { $0 + $1.score }
        return "\(Int((Double(total) / Double(scores.count)).rounded()))"
    }

    private var costCardValue: String {
        costData.map { String(format: "$%.2f", $0.total) } ?? "—"
    }

    private var dominantStatusValue: String {
        guard let top = statusCounts.max(by: { $0.count < $1.count }) else { return "—" }
        return "\(top.count) \(top.status.label)"
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
                        isSelected: selectedCard == .quality,
                        onClick: { selectedCard = selectedCard == .quality ? nil : .quality }
                    )
                    AnalyticsCard(
                        title: "Status",
                        value: dominantStatusValue,
                        isSelected: selectedCard == .status,
                        onClick: { selectedCard = selectedCard == .status ? nil : .status }
                    )
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            // Both fetches are independent — kick off concurrently and await both.
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
            await scoreTask.value
            await costTask.value
        }
    }
}

// MARK: - QualityDrillView

/// Runtime/model summary cards + sortable scores table — right-pane drill for the Quality card.
struct QualityDrillView: View {
    let pods: [Pod]
    let loadScores: (() async throws -> [PodQualityScore])?
    let onSelectPod: ((String) -> Void)?

    @State private var scores: [PodQualityScore] = []
    @State private var scoresLoadError: String? = nil
    @State private var isLoadingScores: Bool = false
    @State private var sortOrder: [KeyPathComparator<PodQualityScore>] = [
        KeyPathComparator(\.computedAt, order: .reverse)
    ]

    private var runtimeModelStats: [RuntimeModelStat] {
        let groups = Dictionary(grouping: scores) { score -> String in
            "\(score.runtime)\u{0001}\(score.model ?? "—")"
        }
        return groups
            .map { key, group -> RuntimeModelStat in
                let parts = key.split(separator: "\u{0001}", maxSplits: 1).map(String.init)
                let runtime = parts.first ?? "?"
                let model = parts.count > 1 ? parts[1] : "—"
                let total = group.reduce(0) { $0 + $1.score }
                let avgScore = Double(total) / Double(group.count)
                let avgCost = group.reduce(0.0) { $0 + $1.costUsd } / Double(group.count)
                return RuntimeModelStat(
                    runtime: runtime,
                    model: model,
                    count: group.count,
                    avgScore: avgScore,
                    avgCost: avgCost,
                    dailyAverages: analyticsDailyAverages(for: group)
                )
            }
            .sorted { $0.count > $1.count }
    }

    private var sortedScores: [PodQualityScore] { scores.sorted(using: sortOrder) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "speedometer")
                        .foregroundStyle(.secondary)
                    Text("Session Quality")
                        .font(.title3.weight(.semibold))
                    Spacer()
                    if isLoadingScores {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("\(scores.count) pod\(scores.count == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let err = scoresLoadError {
                    Text("Couldn't load scores: \(err)")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if scores.isEmpty && !isLoadingScores {
                    Text("No completed pods scored yet. Run a pod to completion and it'll show up here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(runtimeModelStats) { stat in
                                runtimeModelCard(stat)
                            }
                        }
                    }
                    scoresTable
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await fetchScores() }
    }

    private func fetchScores() async {
        guard let loadScores else { return }
        isLoadingScores = true
        defer { isLoadingScores = false }
        do {
            scores = try await loadScores()
            scoresLoadError = nil
        } catch {
            scoresLoadError = error.localizedDescription
        }
    }

    private func runtimeModelCard(_ stat: RuntimeModelStat) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text(stat.runtime)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer()
                Text("\(stat.count)")
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                    .foregroundStyle(.secondary)
            }
            Text(stat.model)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(Int(stat.avgScore.rounded()))")
                    .font(.system(.title2, design: .rounded).weight(.bold))
                    .foregroundStyle(analyticsScoreColor(Int(stat.avgScore.rounded())))
                    .monospacedDigit()
                Text("avg")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if stat.avgCost > 0 {
                Text(String(format: "avg $%.2f", stat.avgCost))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            if stat.dailyAverages.count >= 2 {
                SparklineView(values: stat.dailyAverages, color: analyticsScoreColor(Int(stat.avgScore.rounded())))
                    .frame(height: 24)
                    .padding(.top, 2)
            }
        }
        .padding(10)
        .frame(minWidth: 160, alignment: .leading)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var scoresTable: some View {
        Table(sortedScores, sortOrder: $sortOrder) {
            TableColumn("Score", value: \.score) { s in
                HStack(spacing: 6) {
                    Circle()
                        .fill(analyticsScoreColor(s.score))
                        .frame(width: 8, height: 8)
                    Text("\(s.score)")
                        .font(.system(.body, design: .monospaced).weight(.semibold))
                        .monospacedDigit()
                }
            }
            .width(min: 60, ideal: 70, max: 90)

            TableColumn("Profile", value: \.profileName) { s in
                Text(s.profileName).lineLimit(1)
            }
            .width(min: 110, ideal: 150)

            TableColumn("Runtime", value: \.runtime) { s in
                Text(s.runtime).font(.system(.body, design: .monospaced))
            }
            .width(min: 70, ideal: 80, max: 100)

            TableColumn("Model") { (s: PodQualityScore) in
                Text(s.model ?? "—")
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .width(min: 120, ideal: 180)

            TableColumn("Cost", value: \.costUsd) { s in
                Text(String(format: "$%.2f", s.costUsd))
                    .font(.system(.body, design: .monospaced).monospacedDigit())
            }
            .width(min: 60, ideal: 70, max: 90)

            TableColumn("Completed", value: \.completedAt) { s in
                Text(analyticsRelativeDate(s.completedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .width(min: 100, ideal: 140)

            TableColumn("Pod") { (s: PodQualityScore) in
                Button {
                    onSelectPod?(s.podId)
                } label: {
                    Text(String(s.podId.suffix(8)))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.blue)
                }
                .buttonStyle(.plain)
                .help("Open pod \(s.podId)")
            }
            .width(min: 80, ideal: 100)
        }
        .frame(minHeight: 260)
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

private func analyticsScoreColor(_ score: Int) -> Color {
    switch score {
    case 80...: return .green
    case 60..<80: return .yellow
    default: return .red
    }
}

private func analyticsRelativeDate(_ iso: String) -> String {
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
