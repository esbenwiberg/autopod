import SwiftUI

/// History analysis dashboard — failure patterns, rework stats, and workspace launcher.
public struct HistoryView: View {
    public let sessions: [Session]
    public let actions: SessionActions
    public let profileNames: [String]

    public init(sessions: [Session], actions: SessionActions, profileNames: [String]) {
        self.sessions = sessions
        self.actions = actions
        self.profileNames = profileNames
    }

    @State private var selectedProfile: String?
    @State private var isCreatingWorkspace = false
    @State private var sessionLimit = 100

    // MARK: - Computed stats

    private var workerSessions: [Session] { sessions.filter { !$0.isWorkspace } }

    private var failedSessions: [Session] {
        workerSessions.filter { [.failed, .killed, .reviewRequired].contains($0.status) }
    }

    private var profileHistoryStats: [ProfileHistoryStat] {
        let profiles = Array(Set(workerSessions.map(\.profileName))).sorted()
        return profiles.map { profile in
            let s = workerSessions.filter { $0.profileName == profile }
            let failed = s.filter { [.failed, .killed, .reviewRequired].contains($0.status) }.count
            let completed = s.filter { $0.status == .complete }.count
            let total = s.count
            let totalCost = s.reduce(0.0) { $0 + $1.costUsd }
            let avgCost = total > 0 ? totalCost / Double(total) : 0
            let multiAttempt = s.filter { ($0.attempts?.current ?? 1) > 1 }.count
            let reworkRate = total > 0 ? Double(multiAttempt) / Double(total) : 0
            let avgAttempts: Double = {
                let withAttempts = s.compactMap(\.attempts)
                guard !withAttempts.isEmpty else { return 1.0 }
                return Double(withAttempts.reduce(0) { $0 + $1.current }) / Double(withAttempts.count)
            }()
            return ProfileHistoryStat(
                name: profile,
                totalSessions: total,
                completedCount: completed,
                failedCount: failed,
                successRate: total > 0 ? Double(completed) / Double(total) : 0,
                avgCost: avgCost,
                totalCost: totalCost,
                avgValidationAttempts: avgAttempts,
                reworkRate: reworkRate
            )
        }
    }

    private var recentFailures: [Session] {
        Array(
            failedSessions
                .sorted { $0.startedAt > $1.startedAt }
                .prefix(10)
        )
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header

                heroStats

                if !profileHistoryStats.isEmpty {
                    profileBreakdown
                }

                if !recentFailures.isEmpty {
                    recentFailuresList
                }

                workspaceLauncher
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("History")
                    .font(.title2.weight(.semibold))
                Text("Investigate patterns across past sessions")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    // MARK: - Hero stats

    private var heroStats: some View {
        let totalWorker = workerSessions.count
        let totalFailed = failedSessions.count
        let failureRate = totalWorker > 0 ? Double(totalFailed) / Double(totalWorker) : 0
        let totalCost = workerSessions.reduce(0.0) { $0 + $1.costUsd }
        let wastedCost = failedSessions.reduce(0.0) { $0 + $1.costUsd }

        return HStack(spacing: 0) {
            heroStat(
                value: "\(totalWorker)",
                label: "Total Sessions",
                icon: "square.stack.3d.up"
            )
            Spacer()
            heroStat(
                value: totalWorker > 0 ? "\(totalFailed)" : "—",
                label: "Failed",
                icon: "xmark.circle",
                valueColor: totalFailed > 0 ? .red : .primary
            )
            Spacer()
            heroStat(
                value: totalWorker > 0 ? String(format: "%.0f%%", failureRate * 100) : "—",
                label: "Failure Rate",
                icon: "chart.line.downtrend.xyaxis",
                valueColor: failureRate > 0.3 ? .red : failureRate > 0.15 ? .orange : .primary
            )
            Spacer()
            heroStat(
                value: wastedCost > 0 ? String(format: "$%.2f", wastedCost) : "—",
                label: "Wasted Cost",
                icon: "dollarsign.arrow.trianglehead.counterclockwise.rotate.90",
                valueColor: wastedCost > 0 ? .orange : .primary
            )
        }
        .padding(20)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func heroStat(value: String, label: String, icon: String, valueColor: Color = .primary) -> some View {
        VStack(spacing: 6) {
            Text(value)
                .font(.system(.largeTitle, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(valueColor)
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

    // MARK: - Profile breakdown

    private var profileBreakdown: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("By Profile")
                .font(.subheadline.weight(.semibold))

            ForEach(profileHistoryStats) { stat in
                profileCard(stat)
            }
        }
    }

    private func profileCard(_ stat: ProfileHistoryStat) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(stat.name)
                    .font(.system(.subheadline).weight(.medium))
                    .lineLimit(1)
                Spacer()
                Text(String(format: "%.0f%% success", stat.successRate * 100))
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                    .foregroundStyle(stat.successRate > 0.7 ? .green : stat.successRate > 0.4 ? .orange : .red)
            }

            HStack(spacing: 16) {
                statPill(label: "Sessions", value: "\(stat.totalSessions)")
                statPill(label: "Failed", value: "\(stat.failedCount)", color: stat.failedCount > 0 ? .red : .secondary)
                statPill(label: "Avg Cost", value: String(format: "$%.2f", stat.avgCost))
                statPill(label: "Avg Attempts", value: String(format: "%.1f", stat.avgValidationAttempts))
                if stat.reworkRate > 0 {
                    statPill(label: "Rework", value: String(format: "%.0f%%", stat.reworkRate * 100), color: .orange)
                }
            }

            // Success rate bar
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.red.opacity(0.15))
                        .frame(width: geo.size.width, height: 4)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(stat.successRate > 0.7 ? Color.green.opacity(0.7) : Color.orange.opacity(0.7))
                        .frame(width: max(geo.size.width * stat.successRate, 0), height: 4)
                }
            }
            .frame(height: 4)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func statPill(label: String, value: String, color: Color = .secondary) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(.caption, design: .monospaced).weight(.medium))
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Recent failures

    private var recentFailuresList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recent Failures")
                .font(.subheadline.weight(.semibold))

            ForEach(recentFailures) { session in
                HStack(spacing: 10) {
                    Circle()
                        .fill(session.status == .failed ? Color.red : session.status == .reviewRequired ? Color.orange : Color.gray)
                        .frame(width: 7, height: 7)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(session.id)
                                .font(.system(.caption, design: .monospaced).weight(.medium))
                            Text(session.profileName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let error = session.errorSummary {
                            Text(error)
                                .font(.caption2)
                                .foregroundStyle(.red.opacity(0.8))
                                .lineLimit(2)
                        } else {
                            Text(session.task)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    if let attempts = session.attempts {
                        Text("\(attempts.current)/\(attempts.max)")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }

                    Text(String(format: "$%.2f", session.costUsd))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .padding(8)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    // MARK: - Workspace launcher

    private var workspaceLauncher: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Deep Investigation")
                .font(.subheadline.weight(.semibold))

            VStack(alignment: .leading, spacing: 12) {
                Text("Launch an interactive workspace pod pre-loaded with a SQLite database of your session history. Use Claude Code or sqlite3 to investigate patterns.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 12) {
                    Picker("Profile", selection: $selectedProfile) {
                        Text("Select a profile…").tag(nil as String?)
                        ForEach(profileNames, id: \.self) { name in
                            Text(name).tag(name as String?)
                        }
                    }
                    .frame(width: 180)

                    Picker("Sessions", selection: $sessionLimit) {
                        Text("Last 50").tag(50)
                        Text("Last 100").tag(100)
                        Text("Last 200").tag(200)
                    }
                    .frame(width: 120)

                    Button {
                        Task {
                            isCreatingWorkspace = true
                            await actions.createHistoryWorkspace(selectedProfile, sessionLimit)
                            isCreatingWorkspace = false
                        }
                    } label: {
                        if isCreatingWorkspace {
                            ProgressView()
                                .controlSize(.small)
                                .padding(.horizontal, 4)
                        } else {
                            Label("Open History Workspace", systemImage: "terminal.fill")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isCreatingWorkspace || selectedProfile == nil)
                }
            }
            .padding(16)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}

// MARK: - Supporting types

private struct ProfileHistoryStat: Identifiable {
    let name: String
    let totalSessions: Int
    let completedCount: Int
    let failedCount: Int
    let successRate: Double
    let avgCost: Double
    let totalCost: Double
    let avgValidationAttempts: Double
    let reworkRate: Double
    var id: String { name }
}

// MARK: - Preview

#Preview("History") {
    HistoryView(
        sessions: MockData.all,
        actions: .preview,
        profileNames: ["my-app", "webapp", "backend"]
    )
    .frame(width: 800, height: 700)
}
