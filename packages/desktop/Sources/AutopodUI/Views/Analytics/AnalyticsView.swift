import Charts
import SwiftUI

/// Analytics dashboard — aggregate stats across all sessions.
public struct AnalyticsView: View {
    public let sessions: [Session]

    public init(sessions: [Session]) {
        self.sessions = sessions
    }

    // MARK: - Computed stats

    private var workerSessions: [Session] { sessions.filter { !$0.isWorkspace } }
    private var totalSessions: Int { workerSessions.count }
    private var successCount: Int { workerSessions.filter { $0.status == .complete }.count }
    private var successRate: Double { totalSessions > 0 ? Double(successCount) / Double(totalSessions) : 0 }
    private var totalCost: Double { sessions.reduce(0) { $0 + $1.costUsd } }
    private var totalInputTokens: Int { sessions.reduce(0) { $0 + $1.inputTokens } }
    private var totalOutputTokens: Int { sessions.reduce(0) { $0 + $1.outputTokens } }
    private var totalLinesAdded: Int { sessions.compactMap(\.diffStats).reduce(0) { $0 + $1.added } }

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
        let relevantStatuses: [SessionStatus] = [
            .complete, .failed, .running, .validated,
            .validating, .awaitingInput, .killed, .queued, .provisioning,
        ]
        return relevantStatuses.compactMap { status in
            let count = sessions.filter { $0.status == status }.count
            guard count > 0 else { return nil }
            return StatusCount(status: status, count: count)
        }
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Analytics")
                    .font(.title2.weight(.semibold))

                summaryCards

                if !statusCounts.isEmpty {
                    statusDistributionChart
                }

                if !profileStats.isEmpty {
                    profileBreakdown
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Summary cards

    private var summaryCards: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12)], spacing: 12) {
            statCard(
                icon: "square.stack.3d.up",
                color: .blue,
                title: "Sessions",
                value: "\(totalSessions)"
            )
            statCard(
                icon: "checkmark.circle.fill",
                color: .green,
                title: "Success Rate",
                value: totalSessions > 0 ? String(format: "%.0f%%", successRate * 100) : "—"
            )
            statCard(
                icon: "dollarsign.circle.fill",
                color: .purple,
                title: "Total Cost",
                value: totalCost > 0 ? String(format: "$%.2f", totalCost) : "—"
            )
            statCard(
                icon: "arrow.up.right.circle.fill",
                color: .teal,
                title: "Lines Added",
                value: totalLinesAdded > 0 ? "\(totalLinesAdded)" : "—"
            )
            statCard(
                icon: "text.bubble.fill",
                color: .indigo,
                title: "Input Tokens",
                value: totalInputTokens > 0 ? formatTokens(totalInputTokens) : "—"
            )
            statCard(
                icon: "sparkles",
                color: .orange,
                title: "Output Tokens",
                value: totalOutputTokens > 0 ? formatTokens(totalOutputTokens) : "—"
            )
        }
    }

    private func statCard(icon: String, color: Color, title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .font(.system(size: 16))
            Text(value)
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Status distribution chart

    private var statusDistributionChart: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Status Distribution")
                .font(.subheadline.weight(.semibold))
            Chart(statusCounts) { item in
                BarMark(
                    x: .value("Status", item.status.label),
                    y: .value("Count", item.count)
                )
                .foregroundStyle(item.status.color)
                .cornerRadius(4)
            }
            .chartYAxis {
                AxisMarks(values: .automatic(desiredCount: 4))
            }
            .frame(height: 140)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Profile breakdown

    private var profileBreakdown: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("By Profile")
                .font(.subheadline.weight(.semibold))
            VStack(spacing: 0) {
                profileTableRow(
                    profile: "Profile", sessions: "Sessions",
                    successRate: "Success", avgCost: "Avg Cost",
                    lines: "Lines +", isHeader: true
                )
                Divider()
                ForEach(profileStats) { stat in
                    profileTableRow(
                        profile: stat.name,
                        sessions: "\(stat.sessionCount)",
                        successRate: stat.sessionCount > 0
                            ? String(format: "%.0f%%", stat.successRate * 100) : "—",
                        avgCost: stat.avgCost > 0
                            ? String(format: "$%.2f", stat.avgCost) : "—",
                        lines: stat.totalLinesAdded > 0 ? "+\(stat.totalLinesAdded)" : "—",
                        isHeader: false
                    )
                    if stat.id != profileStats.last?.id {
                        Divider().padding(.leading, 8)
                    }
                }
            }
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func profileTableRow(
        profile: String, sessions: String, successRate: String,
        avgCost: String, lines: String, isHeader: Bool
    ) -> some View {
        HStack {
            Text(profile)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(1)
            Text(sessions)
                .frame(width: 64, alignment: .trailing)
            Text(successRate)
                .frame(width: 64, alignment: .trailing)
                .foregroundStyle(isHeader ? Color.secondary : Color.green)
            Text(avgCost)
                .frame(width: 72, alignment: .trailing)
            Text(lines)
                .frame(width: 72, alignment: .trailing)
                .foregroundStyle(isHeader ? Color.secondary : Color.teal)
        }
        .font(isHeader ? .caption.weight(.semibold) : .caption)
        .foregroundStyle(isHeader ? .secondary : .primary)
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
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
    let status: SessionStatus
    let count: Int
    var id: String { status.rawValue }
}

// MARK: - Preview

#Preview("Analytics") {
    AnalyticsView(sessions: MockData.all)
        .frame(width: 800, height: 600)
}
