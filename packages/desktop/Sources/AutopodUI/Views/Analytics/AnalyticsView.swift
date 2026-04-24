import AutopodClient
import SwiftUI

/// Analytics dashboard — aggregate stats across all pods.
public struct AnalyticsView: View {
    public let pods: [Pod]
    /// Optional closure for fetching persisted quality scores. When nil
    /// (previews, disconnected), the Session Quality section is hidden.
    public var loadScores: (() async throws -> [PodQualityScore])?
    /// Optional callback fired when a row in the scores table is clicked.
    /// Typically: route to the pod detail view (switch sidebar + set selection).
    public var onSelectPod: ((String) -> Void)?

    @State private var scores: [PodQualityScore] = []
    @State private var scoresLoadError: String? = nil
    @State private var isLoadingScores: Bool = false
    @State private var sortOrder: [KeyPathComparator<PodQualityScore>] = [
        KeyPathComparator(\.computedAt, order: .reverse)
    ]

    public init(
        pods: [Pod],
        loadScores: (() async throws -> [PodQualityScore])? = nil,
        onSelectPod: ((String) -> Void)? = nil
    ) {
        self.pods = pods
        self.loadScores = loadScores
        self.onSelectPod = onSelectPod
    }

    // MARK: - Computed stats

    private var workerSessions: [Pod] { pods.filter { !$0.isWorkspace } }
    private var totalSessions: Int { workerSessions.count }
    private var successCount: Int { workerSessions.filter { $0.status == .complete }.count }
    private var successRate: Double { totalSessions > 0 ? Double(successCount) / Double(totalSessions) : 0 }
    private var totalCost: Double { pods.filter { $0.status != .running && $0.status != .paused }.reduce(0) { $0 + $1.costUsd } }
    private var totalInputTokens: Int { pods.reduce(0) { $0 + $1.inputTokens } }
    private var totalOutputTokens: Int { pods.reduce(0) { $0 + $1.outputTokens } }
    private var totalLinesAdded: Int { pods.compactMap(\.diffStats).reduce(0) { $0 + $1.added } }

    private var profileStats: [ProfileStat] {
        let profiles = Array(Set(workerSessions.map(\.profileName))).sorted()
        return profiles.map { profile in
            let s = workerSessions.filter { $0.profileName == profile }
            let completed = s.filter { $0.status == .complete }.count
            let cost = s.reduce(0.0) { $0 + $1.costUsd }
            let avgCost = s.isEmpty ? 0 : cost / Double(s.count)
            let linesAdded = s.compactMap(\.diffStats).reduce(0) { $0 + $1.added }
            return ProfileStat(
                name: profile,
                sessionCount: s.count,
                successRate: s.isEmpty ? 0 : Double(completed) / Double(s.count),
                avgCost: avgCost,
                totalLinesAdded: linesAdded
            )
        }
    }

    private var statusCounts: [StatusCount] {
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

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Analytics")
                    .font(.title2.weight(.semibold))

                heroStats

                secondaryStats

                if !statusCounts.isEmpty {
                    statusProportionBar
                }

                if !profileStats.isEmpty {
                    profileBreakdown
                }

                if loadScores != nil {
                    qualitySection
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            await fetchScores()
        }
    }

    // MARK: - Session Quality (Phase 3e)

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
                // Daily averages for the sparkline — last 30 days, sorted ascending.
                let dayAverages = Self.dailyAverages(for: group)
                return RuntimeModelStat(
                    runtime: runtime,
                    model: model,
                    count: group.count,
                    avgScore: avgScore,
                    avgCost: avgCost,
                    dailyAverages: dayAverages
                )
            }
            .sorted { $0.count > $1.count }
    }

    /// Groups scores by calendar day and returns sorted daily averages (ascending).
    private static func dailyAverages(for group: [PodQualityScore]) -> [Double] {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        let cutoff = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
        let byDay = Dictionary(grouping: group.filter {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let d = iso.date(from: $0.completedAt) ?? ISO8601DateFormatter().date(from: $0.completedAt) ?? Date.distantPast
            return d >= cutoff
        }) { score -> String in
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let d = iso.date(from: score.completedAt) ?? ISO8601DateFormatter().date(from: score.completedAt) ?? Date.distantPast
            return fmt.string(from: d)
        }
        return byDay.keys.sorted().compactMap { day -> Double? in
            guard let group = byDay[day], !group.isEmpty else { return nil }
            return Double(group.reduce(0) { $0 + $1.score }) / Double(group.count)
        }
    }

    private var sortedScores: [PodQualityScore] {
        scores.sorted(using: sortOrder)
    }

    private var qualitySection: some View {
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
                // Per-(runtime, model) aggregate cards — the model-drift sniffer.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(runtimeModelStats) { stat in
                            runtimeModelCard(stat)
                        }
                    }
                }

                // Recent scores table — sortable via KeyPathComparator.
                scoresTable
            }
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
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
                    .foregroundStyle(scoreColor(Int(stat.avgScore.rounded())))
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
                SparklineView(values: stat.dailyAverages, color: scoreColor(Int(stat.avgScore.rounded())))
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
                        .fill(scoreColor(s.score))
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
                Text(relativeDate(s.completedAt))
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

    private func scoreColor(_ score: Int) -> Color {
        switch score {
        case 80...: return .green
        case 60..<80: return .yellow
        default: return .red
        }
    }

    private func relativeDate(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date = parsed else { return iso }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .short
        return rel.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Hero stats (top 3 KPIs)

    private var heroStats: some View {
        HStack(spacing: 0) {
            heroStat(
                value: "\(totalSessions)",
                label: "Pods",
                icon: "square.stack.3d.up"
            )
            Spacer()
            heroStat(
                value: totalSessions > 0 ? String(format: "%.0f%%", successRate * 100) : "—",
                label: "Success Rate",
                icon: "checkmark.circle"
            )
            Spacer()
            heroStat(
                value: totalCost > 0 ? String(format: "$%.2f", totalCost) : "—",
                label: "Total Cost",
                icon: "dollarsign.circle"
            )
        }
        .padding(20)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func heroStat(value: String, label: String, icon: String) -> some View {
        VStack(spacing: 6) {
            Text(value)
                .font(.system(.largeTitle, design: .rounded).weight(.bold))
                .monospacedDigit()
                .contentTransition(.numericText())
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                Text(label)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Secondary stats

    private var secondaryStats: some View {
        HStack(spacing: 12) {
            secondaryStat(
                icon: "arrow.up.right",
                value: totalLinesAdded > 0 ? "+\(totalLinesAdded)" : "—",
                label: "Lines Added"
            )
            secondaryStat(
                icon: "arrow.up.circle",
                value: totalInputTokens > 0 ? formatTokens(totalInputTokens) : "—",
                label: "Input Tokens"
            )
            secondaryStat(
                icon: "arrow.down.circle",
                value: totalOutputTokens > 0 ? formatTokens(totalOutputTokens) : "—",
                label: "Output Tokens"
            )
        }
    }

    private func secondaryStat(icon: String, value: String, label: String) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .monospacedDigit()
            HStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 9))
                Text(label)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Status proportion bar (GitHub language bar style)

    private var statusProportionBar: some View {
        let total = statusCounts.reduce(0) { $0 + $1.count }
        return VStack(alignment: .leading, spacing: 10) {
            Text("Status Distribution")
                .font(.subheadline.weight(.semibold))

            // Segmented bar
            GeometryReader { geo in
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
            .frame(height: 10)

            // Legend
            FlowLayout(spacing: 12) {
                ForEach(statusCounts) { item in
                    HStack(spacing: 5) {
                        Circle()
                            .fill(item.status.color)
                            .frame(width: 7, height: 7)
                        Text(item.status.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(item.count)")
                            .font(.system(.caption, design: .monospaced).weight(.medium))
                            .monospacedDigit()
                    }
                }
            }
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Profile breakdown (card rows)

    private var profileBreakdown: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("By Profile")
                .font(.subheadline.weight(.semibold))

            ForEach(profileStats) { stat in
                profileCard(stat)
            }
        }
    }

    private func profileCard(_ stat: ProfileStat) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(stat.name)
                    .font(.system(.subheadline).weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 12) {
                    Text("\(stat.sessionCount) pods")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if stat.avgCost > 0 {
                        Text(String(format: "avg $%.2f", stat.avgCost))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    if stat.totalLinesAdded > 0 {
                        Text("+\(stat.totalLinesAdded) lines")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            // Success rate with inline bar
            VStack(alignment: .trailing, spacing: 4) {
                Text(stat.sessionCount > 0 ? String(format: "%.0f%%", stat.successRate * 100) : "—")
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    .monospacedDigit()
                // Tiny progress bar
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.secondary.opacity(0.15))
                        .frame(width: 48, height: 3)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(stat.successRate > 0.5 ? Color.green.opacity(0.7) : Color.orange.opacity(0.7))
                        .frame(width: max(48 * stat.successRate, 0), height: 3)
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Helpers

    private func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fK", Double(count) / 1_000)
        }
        return "\(count)"
    }
}

// MARK: - Flow layout for legend wrapping

private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var height: CGFloat = 0
        for (index, row) in rows.enumerated() {
            let rowHeight = row.map { subviews[$0].sizeThatFits(.unspecified).height }.max() ?? 0
            height += rowHeight
            if index < rows.count - 1 { height += spacing / 2 }
        }
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            let rowHeight = row.map { subviews[$0].sizeThatFits(.unspecified).height }.max() ?? 0
            var x = bounds.minX
            for index in row {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += rowHeight + spacing / 2
        }
    }

    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [[Int]] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [[Int]] = [[]]
        var currentWidth: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if currentWidth + size.width > maxWidth && !rows[rows.count - 1].isEmpty {
                rows.append([])
                currentWidth = 0
            }
            rows[rows.count - 1].append(index)
            currentWidth += size.width + spacing
        }
        return rows
    }
}

// MARK: - Supporting types

struct ProfileStat: Identifiable {
    let name: String
    let sessionCount: Int
    let successRate: Double
    let avgCost: Double
    let totalLinesAdded: Int
    var id: String { name }
}

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

/// Mini line chart for the runtime/model quality score over the last 30 days.
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
                // Fill
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

                // Line
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

#Preview("Analytics") {
    AnalyticsView(pods: MockData.all)
        .frame(width: 800, height: 600)
}
