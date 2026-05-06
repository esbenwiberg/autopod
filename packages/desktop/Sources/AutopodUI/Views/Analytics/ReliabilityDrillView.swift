import AutopodClient
import Charts
import SwiftUI

// MARK: - ReliabilityDrillView

/// Right-pane drill for the Reliability card — fetches reliability analytics and renders
/// four sections: funnel, stage failures, profile heatmap, and summary callout.
struct ReliabilityDrillView: View {
    let loadReliability: (() async throws -> ReliabilityAnalyticsResponse)?
    let onSelectPod: ((String) -> Void)?

    @State private var data: ReliabilityAnalyticsResponse?
    @State private var loadError: String?
    @State private var isLoading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.shield")
                        .foregroundStyle(.secondary)
                    Text("Reliability Analytics")
                        .font(.title3.weight(.semibold))
                    Spacer()
                    if isLoading { ProgressView().controlSize(.small) }
                }

                if let err = loadError {
                    InlineErrorBanner(message: "Couldn't load reliability data: \(err)")
                }

                if let d = data {
                    ReliabilityFunnelSectionView(funnel: d.funnel, onSelectPod: onSelectPod)
                    Divider()
                    ReliabilityStageFailureSectionView(stageFailures: d.stageFailures)
                    Divider()
                    ReliabilityProfileHeatmapSectionView(profileHeatmap: d.profileHeatmap)
                    Divider()
                    ReliabilitySummaryCalloutView(summary: d.summary)
                } else if !isLoading && loadError == nil {
                    skeletonPlaceholder
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await fetchData() }
    }

    private func fetchData() async {
        guard let loadReliability else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            data = try await loadReliability()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private var skeletonPlaceholder: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(nsColor: .separatorColor).opacity(0.5))
                    .frame(height: 40)
            }
        }
    }
}

// MARK: - Inline error banner

private struct InlineErrorBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.red)
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
            Spacer()
        }
        .padding(10)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Section 1: Funnel

private struct ReliabilityFunnelSectionView: View {
    let funnel: ReliabilityFunnel
    let onSelectPod: ((String) -> Void)?

    @State private var expandedDrops: Set<String> = []

    private var isEmpty: Bool { funnel.bands.allSatisfy { $0.count == 0 } }
    /// Pre-derived once per render so both bandRow and dropArrow avoid repeated O(n) passes.
    private var dropsByBand: [FunnelBand: [DropEntry]] {
        Dictionary(grouping: funnel.drops, by: \.from)
    }

    var body: some View {
        let maxCount = funnel.bands.map(\.count).max() ?? 1
        let dropsMap = dropsByBand

        return VStack(alignment: .leading, spacing: 8) {
            Text("Lifecycle Funnel")
                .font(.headline)

            if isEmpty {
                Text("No terminal pods in window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                GeometryReader { geo in
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(funnel.bands, id: \.band) { bandCount in
                            bandRow(bandCount, maxCount: maxCount, drops: dropsMap[bandCount.band] ?? [], availableWidth: geo.size.width)
                        }
                    }
                }
                .frame(height: CGFloat(funnel.bands.count) * 52)

                // Drop disclosures rendered outside GeometryReader for natural height
                ForEach(funnel.drops, id: \.self) { drop in
                    dropDisclosure(drop)
                }
            }
        }
    }

    private func bandRow(_ bc: BandCount, maxCount: Int, drops: [DropEntry], availableWidth: CGFloat) -> some View {
        let fraction = maxCount > 0 ? CGFloat(bc.count) / CGFloat(maxCount) : 0
        let bandWidth = max(availableWidth * fraction, 40)

        return VStack(alignment: .leading, spacing: 2) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.accentColor.opacity(0.18))
                    .frame(width: bandWidth, height: 36)
                Text("\(bc.band.rawValue) (\(bc.count))")
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                    .padding(.horizontal, 8)
                    .lineLimit(1)

                // Drop arrows at the right edge of band
                HStack(spacing: 4) {
                    Spacer().frame(width: bandWidth)
                    ForEach(drops, id: \.self) { drop in
                        dropArrow(drop)
                    }
                }
            }
        }
        .frame(height: 44)
    }

    private func dropArrow(_ drop: DropEntry) -> some View {
        let color: Color = drop.to == .failed ? .red : .secondary
        let key = dropKey(drop)

        return Button {
            if expandedDrops.contains(key) {
                expandedDrops.remove(key)
            } else {
                expandedDrops.insert(key)
            }
        } label: {
            Text("→ \(drop.to.rawValue) (\(drop.count))")
                .font(.caption2.weight(.medium))
                .foregroundStyle(color)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(color.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func dropDisclosure(_ drop: DropEntry) -> some View {
        if expandedDrops.contains(dropKey(drop)) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(drop.topPods, id: \.podId) { entry in
                    dropPodRow(entry)
                    Divider()
                }
                if drop.overflow > 0 {
                    Text("+ \(drop.overflow) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 4)
                }
            }
            .padding(.vertical, 4)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.bottom, 8)
        }
    }

    private func dropPodRow(_ entry: DropPodEntry) -> some View {
        Button {
            onSelectPod?(entry.podId)
        } label: {
            HStack(spacing: 10) {
                Text(String(entry.podId.prefix(8)))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.blue)
                Text(entry.profile)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                finalStatusBadge(entry.finalStatus)
                Text(analyticsRelativeDate(entry.completedAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }

    private func finalStatusBadge(_ status: FinalStatus) -> some View {
        let (label, color): (String, Color) = switch status {
        case .complete: ("complete", .green)
        case .failed:   ("failed", .red)
        case .killed:   ("killed", .secondary)
        }
        return Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func dropKey(_ drop: DropEntry) -> String {
        "\(drop.from.rawValue)-\(drop.to.rawValue)"
    }
}

extension DropEntry: Hashable {
    public static func == (lhs: DropEntry, rhs: DropEntry) -> Bool {
        lhs.from == rhs.from && lhs.to == rhs.to && lhs.count == rhs.count
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(from)
        hasher.combine(to)
        hasher.combine(count)
    }
}

// MARK: - Section 2: Stage failure bar chart

private struct ReliabilityStageFailureSectionView: View {
    let stageFailures: [StageFailureRow]

    var body: some View {
        let sorted = stageFailures.sorted { $0.failureRate > $1.failureRate }

        return VStack(alignment: .leading, spacing: 8) {
            Text("Stage Failure Rates")
                .font(.headline)

            if stageFailures.allSatisfy({ $0.podsRan == 0 }) {
                Text("No validation data.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Chart(sorted, id: \.stage) { row in
                    BarMark(
                        x: .value("Failure rate", row.failureRate),
                        y: .value("Stage", row.stage.rawValue)
                    )
                    .foregroundStyle(Color.red.opacity(0.75))
                    .annotation(position: .trailing, alignment: .leading) {
                        Text("\(row.podsFailed)/\(row.podsRan)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .chartXScale(domain: 0...1)
                .chartXAxis {
                    AxisMarks(values: [0, 0.25, 0.5, 0.75, 1.0]) {
                        AxisGridLine()
                        AxisValueLabel(format: .percent)
                    }
                }
                .frame(height: CGFloat(sorted.count) * 32 + 20)
            }
        }
    }
}

// MARK: - Section 3: Profile heatmap

private struct ReliabilityProfileHeatmapSectionView: View {
    let profileHeatmap: [ProfileHeatmapRow]

    private let stages = ValidationStage.allCases

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Profile × Stage Heatmap")
                .font(.headline)

            if profileHeatmap.isEmpty {
                Text("No profile data.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    heatmapGrid
                }
            }
        }
    }

    private var heatmapGrid: some View {
        let columns: [GridItem] = [GridItem(.fixed(140))] + stages.map { _ in
            GridItem(.fixed(72), spacing: 4)
        }
        return LazyVGrid(columns: columns, spacing: 4) {
            // Header row
            Text("Profile")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(stages, id: \.self) { stage in
                Text(stage.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .rotationEffect(.degrees(-30))
                    .frame(maxWidth: .infinity, alignment: .center)
            }

            // Body rows
            ForEach(profileHeatmap, id: \.profile) { row in
                Text(row.profile)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(stages, id: \.self) { stage in
                    heatmapCell(row: row, stage: stage)
                }
            }
        }
    }

    private func heatmapCell(row: ProfileHeatmapRow, stage: ValidationStage) -> some View {
        Group {
            if let cell = row.stages.first(where: { $0.stage == stage }), cell.podsRan > 0 {
                VStack(spacing: 1) {
                    Text("\(Int(cell.failureRate * 100))%")
                        .font(.caption2.weight(.semibold))
                    Text("\(cell.podsFailed)/\(cell.podsRan)")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(Color.red.opacity(min(cell.failureRate * 1.2, 1.0)))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                Text("—")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(Color(nsColor: .separatorColor).opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        }
    }
}

// MARK: - Section 4: Summary callout

private struct ReliabilitySummaryCalloutView: View {
    let summary: ReliabilitySummary

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Summary")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Top failure stage")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(summary.topFailureStage.map { $0.rawValue.capitalized } ?? "All clear")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(summary.topFailureStage == nil ? .green : .red)
                }

                Divider().frame(height: 44)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Avg reworks")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(String(format: "%.2f", summary.avgReworkCount))
                        .font(.title2.weight(.bold))
                        .monospacedDigit()
                }

                Divider().frame(height: 44)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Pods in window")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(summary.totalPodsInWindow)")
                        .font(.title2.weight(.bold))
                        .monospacedDigit()
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
