import SwiftUI

/// Analytics dashboard — aggregate stats across all pods.
public struct AnalyticsView: View {
    public let pods: [Pod]

    public init(pods: [Pod]) {
        self.pods = pods
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
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
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

// MARK: - Preview

#Preview("Analytics") {
    AnalyticsView(pods: MockData.all)
        .frame(width: 800, height: 600)
}
