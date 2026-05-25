import AutopodClient
import SwiftUI

struct MemoryAnalyticsDrillView: View {
    let load: ((Int) async throws -> MemoryAnalyticsResponse)?

    @State private var response: MemoryAnalyticsResponse?
    @State private var days: Int = 30
    @State private var isLoading = false
    @State private var loadError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerRow

                if let loadError {
                    inlineError("Couldn't load memory analytics: \(loadError)")
                }

                if isLoading && response == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else if let response {
                    fleetCounts(response.summary)
                    Divider()
                    repeatedPain(response.impact)
                    Divider()
                    topMemories(response.topMemories)
                } else {
                    Text("Memory analytics not available.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: days) { await fetchData() }
    }

    private var headerRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "brain")
                .foregroundStyle(.secondary)
            Text("Memory Analytics")
                .font(.title3.weight(.semibold))
            Spacer()
            if isLoading { ProgressView().controlSize(.small) }
            Picker("Days", selection: $days) {
                Text("7d").tag(7)
                Text("14d").tag(14)
                Text("30d").tag(30)
                Text("60d").tag(60)
                Text("90d").tag(90)
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(width: 70)
        }
    }

    private func fleetCounts(_ summary: MemoryAnalyticsSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Fleet Loop Counts")
                .font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 10)], spacing: 10) {
                metric("selected", summary.selectedCount)
                metric("injected", summary.injectedCount)
                metric("read", summary.readCount)
                metric("applied", summary.appliedCount)
                metric("not reported", summary.notReportedCount)
            }
            Text("\(summary.candidateCount) candidates · \(summary.approvedCandidateCount) approved")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func repeatedPain(_ impact: MemoryAnalyticsImpact) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Repeated-Pain Deltas")
                .font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 138), spacing: 10)], spacing: 10) {
                deltaMetric("quality", impact.qualityDelta, suffix: "pp", lowerIsBetter: false)
                deltaMetric("validation", impact.validationFailureDelta, suffix: "", lowerIsBetter: true)
                deltaMetric("fix attempts", impact.fixAttemptDelta, suffix: "", lowerIsBetter: true)
                deltaMetric("escalations", impact.escalationDelta, suffix: "", lowerIsBetter: true)
                deltaMetric("cost", impact.costDeltaUsd, prefix: "$", suffix: "", lowerIsBetter: true)
            }
            Text("Compared \(impact.cohortSize) memory-influenced pods with \(impact.comparisonCohortSize) prior peers.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func topMemories(_ memories: [MemoryAnalyticsTopMemory]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Top Memory Signals")
                .font(.headline)
            if memories.isEmpty {
                Text("No memory usage recorded in this window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(memories, id: \.memoryId) { memory in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(memory.path)
                            .font(.system(.caption, design: .monospaced).weight(.medium))
                        HStack(spacing: 10) {
                            Text("selected \(memory.selectedCount)")
                            Text("injected \(memory.injectedCount)")
                            Text("applied \(memory.appliedCount)")
                            Text("stale \(memory.harmfulStaleCount)")
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        if let impact = memory.impactSummary, !impact.isEmpty {
                            Text(impact)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                    Divider()
                }
            }
        }
    }

    private func metric(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(value)")
                .font(.system(.title3, design: .monospaced).weight(.semibold))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func deltaMetric(
        _ label: String,
        _ value: Double?,
        prefix: String = "",
        suffix: String,
        lowerIsBetter: Bool
    ) -> some View {
        let display = value.map { "\(prefix)\(String(format: "%+.1f", $0))\(suffix)" } ?? "—"
        let good = value.map { lowerIsBetter ? $0 < 0 : $0 > 0 } ?? false
        return VStack(alignment: .leading, spacing: 3) {
            Text(display)
                .font(.system(.body, design: .monospaced).weight(.semibold))
                .foregroundStyle(deltaColor(value: value, good: good))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func inlineError(_ message: String) -> some View {
        Text(message)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func deltaColor(value: Double?, good: Bool) -> Color {
        guard value != nil else { return Color.secondary }
        return good ? Color.green : Color.orange
    }

    private func fetchData() async {
        guard let load else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await load(days)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}
