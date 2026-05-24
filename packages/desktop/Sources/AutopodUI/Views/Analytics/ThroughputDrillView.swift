import AutopodClient
import Charts
import SwiftUI

// MARK: - Cached ISO formatters

nonisolated(unsafe) private let _tputIsoFullFmt: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
nonisolated(unsafe) private let _tputIsoBasicFmt = ISO8601DateFormatter()

// MARK: - ThroughputDrillView

/// Right-pane drill for the Throughput card — three sections:
/// 1. Hour-of-day × day-of-week heatmap (client-side bucketed from cohort)
/// 2. Hourly queue-depth time-series (mean area + max line)
/// 3. Time-in-status box plot (p25/p50/p75 box, p90 whisker, max marker)
struct ThroughputDrillView: View {
    let load: ((Int) async throws -> ThroughputAnalyticsResponse)?
    let onSelectPod: ((String) -> Void)?

    @State private var response: ThroughputAnalyticsResponse?
    @State private var days: Int = 30
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var heatmapGrid: [[HeatmapCellData]] = []
    @State private var parsedQueueDepth: [(date: Date, max: Double, mean: Double)] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerRow

                if let err = loadError {
                    ThroughputInlineErrorBanner(message: "Couldn't load throughput data: \(err)")
                }

                if isLoading && response == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else {
                    heatmapSection
                    Divider()
                    queueDepthSection
                    Divider()
                    timeInStatusSection
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: days) { await fetchData() }
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "speedometer")
                .foregroundStyle(.secondary)
            Text("Throughput Analytics")
                .font(.title3.weight(.semibold))
            Spacer()
            if isLoading { ProgressView().controlSize(.small) }
            daysPicker
        }
    }

    private var daysPicker: some View {
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

    // MARK: - Section 1: Heatmap

    private var heatmapSection: some View {
        ThroughputHeatmapSectionView(
            grid: heatmapGrid,
            days: days,
            cohortTruncated: response?.cohortTruncated ?? false,
            onSelectPod: onSelectPod
        )
    }

    // MARK: - Section 2: Queue depth

    private var queueDepthSection: some View {
        ThroughputQueueDepthSectionView(
            buckets: parsedQueueDepth,
            days: days
        )
    }

    // MARK: - Section 3: Time in status

    private var timeInStatusSection: some View {
        ThroughputTimeInStatusSectionView(
            timeInStatus: response?.timeInStatus ?? [],
            days: days
        )
    }

    // MARK: - Fetch

    private func fetchData() async {
        guard let load else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let r = try await load(days)
            response = r
            heatmapGrid = buildHeatmapGrid(from: r.cohort)
            parsedQueueDepth = r.queueDepth.compactMap { b in
                guard let date = _tputIsoBasicFmt.date(from: b.hour) else { return nil }
                return (date: date, max: b.max, mean: b.mean)
            }
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

// MARK: - Heatmap cell data

private struct HeatmapCellData {
    let pods: [ThroughputCohortPod]
    var count: Int { pods.count }
}

// MARK: - Heatmap grid builder

private func buildHeatmapGrid(from cohort: [ThroughputCohortPod]) -> [[HeatmapCellData]] {
    var buckets = [String: [ThroughputCohortPod]]()
    let cal = Calendar.current

    for pod in cohort {
        let date = _tputIsoFullFmt.date(from: pod.completedAt) ?? _tputIsoBasicFmt.date(from: pod.completedAt)
        guard let date else { continue }
        let comps = cal.dateComponents([.weekday, .hour], from: date)
        guard let weekday = comps.weekday, let hour = comps.hour else { continue }
        let key = "\(weekday - 1)-\(hour)"  // weekday: 1=Sun → 0-based
        buckets[key, default: []].append(pod)
    }

    return (0..<7).map { day in
        (0..<24).map { hour in
            let pods = (buckets["\(day)-\(hour)"] ?? []).sorted { $0.completedAt > $1.completedAt }
            return HeatmapCellData(pods: pods)
        }
    }
}

// MARK: - Section 1: Heatmap view

private struct ThroughputHeatmapSectionView: View {
    let grid: [[HeatmapCellData]]  // [day][hour]
    let days: Int
    let cohortTruncated: Bool
    let onSelectPod: ((String) -> Void)?

    @State private var expandedCellKey: String?

    private let dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private let cellSize: CGFloat = 28

    private var maxCount: Int {
        grid.flatMap { $0 }.map(\.count).max() ?? 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Hour × Day Heatmap")
                .font(.headline)

            if grid.flatMap({ $0 }).allSatisfy({ $0.count == 0 }) {
                Text("No completed pods in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    heatmapGrid
                }

                if let key = expandedCellKey,
                   let (day, hour) = parseCellKey(key),
                   day < grid.count, hour < grid[day].count {
                    cellExpansionView(cell: grid[day][hour], day: day, hour: hour)
                }

                if cohortTruncated {
                    Text("Showing the most recent 5,000 pods.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var heatmapGrid: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Hour header row
            HStack(spacing: 3) {
                Text("").frame(width: 36)
                ForEach(0..<24, id: \.self) { hour in
                    Text(hour % 6 == 0 ? "\(hour)" : "")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .frame(width: cellSize, alignment: .leading)
                }
            }
            // Day rows
            ForEach(0..<7, id: \.self) { day in
                HStack(spacing: 3) {
                    Text(dayLabels[day])
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, alignment: .leading)
                    ForEach(0..<24, id: \.self) { hour in
                        heatmapCell(day: day, hour: hour)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func heatmapCell(day: Int, hour: Int) -> some View {
        if day < grid.count, hour < grid[day].count {
            let cell = grid[day][hour]
            let key = cellKey(day: day, hour: hour)
            let isExpanded = expandedCellKey == key
            let opacity = cell.count > 0 ? Double(cell.count) / Double(max(maxCount, 1)) : 0
            Button {
                guard cell.count > 0 else { return }
                expandedCellKey = isExpanded ? nil : key
            } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(
                            cell.count > 0
                                ? Color.accentColor.opacity(max(0.08 + opacity * 0.92, 0.08))
                                : Color(nsColor: .separatorColor).opacity(0.12)
                        )
                    if cell.count > 0 {
                        Text("\(cell.count)")
                            .font(.system(size: 8, weight: .medium))
                            .foregroundStyle(opacity > 0.6 ? .white : .primary)
                    }
                    if isExpanded {
                        RoundedRectangle(cornerRadius: 3)
                            .stroke(Color.accentColor, lineWidth: 1.5)
                    }
                }
                .frame(width: cellSize, height: cellSize)
            }
            .buttonStyle(.plain)
            .disabled(cell.count == 0)
        } else {
            Color.clear.frame(width: cellSize, height: cellSize)
        }
    }

    @ViewBuilder
    private func cellExpansionView(cell: HeatmapCellData, day: Int, hour: Int) -> some View {
        let shown = Array(cell.pods.prefix(10))
        let overflow = cell.count - shown.count
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("\(dayLabels[day]) \(String(format: "%02d:00", hour)) — \(cell.count) pod\(cell.count == 1 ? "" : "s")")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button { expandedCellKey = nil } label: {
                    Image(systemName: "xmark")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            Divider()

            ForEach(shown, id: \.podId) { pod in
                podRow(pod)
                Divider()
            }
            if overflow > 0 {
                Text("+ \(overflow) more")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 10)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func podRow(_ pod: ThroughputCohortPod) -> some View {
        Button { onSelectPod?(pod.podId) } label: {
            HStack(spacing: 10) {
                Text(String(pod.podId.prefix(8)))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.blue)
                Text(pod.profile)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                throughputStatusBadge(pod.status)
                Text(analyticsRelativeDate(pod.completedAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }

    private func throughputStatusBadge(_ status: ThroughputPodStatus) -> some View {
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

    private func cellKey(day: Int, hour: Int) -> String { "\(day)-\(hour)" }

    private func parseCellKey(_ key: String) -> (Int, Int)? {
        let parts = key.split(separator: "-")
        guard parts.count == 2, let d = Int(parts[0]), let h = Int(parts[1]) else { return nil }
        return (d, h)
    }
}

// MARK: - Section 2: Queue depth chart

private struct ThroughputQueueDepthSectionView: View {
    let buckets: [(date: Date, max: Double, mean: Double)]
    let days: Int

    private var hasData: Bool {
        buckets.contains { $0.max > 0 || $0.mean > 0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Queue Depth")
                .font(.headline)

            if !hasData {
                Text("No queue history in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Chart {
                    ForEach(buckets.indices, id: \.self) { i in
                        let b = buckets[i]
                        AreaMark(
                            x: .value("Hour", b.date),
                            y: .value("Mean depth", b.mean)
                        )
                        .foregroundStyle(Color.accentColor.opacity(0.2))
                        LineMark(
                            x: .value("Hour", b.date),
                            y: .value("Max depth", b.max)
                        )
                        .foregroundStyle(Color.accentColor)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .stride(by: .day)) {
                        AxisGridLine()
                        AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    }
                }
                .chartYAxisLabel("Pods in queue")
                .frame(height: 140)

                HStack(spacing: 12) {
                    legendDot(Color.accentColor, label: "Max")
                    legendDot(Color.accentColor.opacity(0.4), label: "Mean")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
    }

    private func legendDot(_ color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(label)
        }
    }
}

// MARK: - Time-in-status display helper

/// Per-row rendering data produced by `prepareTimeInStatusDisplay`.
struct TimeInStatusDisplayRow {
    let source: TimeInStatusBox
    let displayP25: Double
    let displayP50: Double
    let displayP75: Double
    let displayP90: Double
    let displayMax: Double
    /// True when `source.max` was clamped to the display cap.
    let isMaxClipped: Bool
}

/// Result of `prepareTimeInStatusDisplay`: capped rows plus the resolved cap value.
struct TimeInStatusDisplayData {
    let rows: [TimeInStatusDisplayRow]
    let displayCap: Double
}

/// Computes a rendering-only x-axis cap from the core (p25–p90) distribution so that
/// hour-long outlier max values do not collapse the visible minute-scale box/whisker.
/// Does not mutate `TimeInStatusBox` values.
func prepareTimeInStatusDisplay(_ boxes: [TimeInStatusBox]) -> TimeInStatusDisplayData {
    let nonEmpty = boxes.filter { $0.sampleCount > 0 }

    guard !nonEmpty.isEmpty else {
        let rows = boxes.map {
            TimeInStatusDisplayRow(
                source: $0, displayP25: 0, displayP50: 0,
                displayP75: 0, displayP90: 0, displayMax: 0, isMaxClipped: false
            )
        }
        return TimeInStatusDisplayData(rows: rows, displayCap: 1)
    }

    let coreUpper = nonEmpty.flatMap { [$0.p25, $0.p50, $0.p75, $0.p90] }.max() ?? 0
    let fullUpper = nonEmpty.map(\.max).max() ?? 0
    let outlierThreshold = max(max(coreUpper * 1.25, coreUpper + 60), 1.0)
    let displayCap = fullUpper <= outlierThreshold ? max(fullUpper, 1) : outlierThreshold

    let rows = boxes.map { box in
        TimeInStatusDisplayRow(
            source: box,
            displayP25: min(box.p25, displayCap),
            displayP50: min(box.p50, displayCap),
            displayP75: min(box.p75, displayCap),
            displayP90: min(box.p90, displayCap),
            displayMax: min(box.max, displayCap),
            isMaxClipped: box.sampleCount > 0 && box.max > displayCap
        )
    }
    return TimeInStatusDisplayData(rows: rows, displayCap: displayCap)
}

// MARK: - Section 3: Time-in-status box plot

private struct ThroughputTimeInStatusSectionView: View {
    let timeInStatus: [TimeInStatusBox]
    let days: Int

    private var allEmpty: Bool {
        timeInStatus.allSatisfy { $0.sampleCount == 0 }
    }

    private var displayData: TimeInStatusDisplayData {
        prepareTimeInStatusDisplay(timeInStatus)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Time in Status")
                .font(.headline)

            if allEmpty {
                Text("No status-transition history in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Chart {
                    ForEach(displayData.rows, id: \.source.status) { row in
                        let label = row.source.status.rawValue
                        if row.source.sampleCount > 0 {
                            // Box: p25 → p75
                            BarMark(
                                xStart: .value("P25", row.displayP25),
                                xEnd: .value("P75", row.displayP75),
                                y: .value("Status", label)
                            )
                            .foregroundStyle(Color.accentColor.opacity(0.5))

                            // Median line
                            RuleMark(
                                x: .value("P50", row.displayP50),
                                yStart: .value("Status", label),
                                yEnd: .value("Status", label)
                            )
                            .foregroundStyle(Color.accentColor)
                            .lineStyle(StrokeStyle(lineWidth: 2))

                            // Whisker: p75 → p90
                            RuleMark(
                                xStart: .value("P75", row.displayP75),
                                xEnd: .value("P90", row.displayP90),
                                y: .value("Status", label)
                            )
                            .foregroundStyle(Color.accentColor.opacity(0.6))
                            .lineStyle(StrokeStyle(lineWidth: 1.5))

                            // Max marker — clamped to displayCap for outliers
                            PointMark(
                                x: .value("Max", row.displayMax),
                                y: .value("Status", label)
                            )
                            .foregroundStyle(Color.accentColor.opacity(0.7))
                            .symbolSize(30)
                            .annotation(position: .trailing) {
                                if row.isMaxClipped, let formatted = formatMttmSeconds(row.source.max) {
                                    Text("max \(formatted)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .chartXScale(domain: 0...displayData.displayCap)
                .chartXAxis {
                    AxisMarks { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let s = value.as(Double.self) {
                                Text(formatSecondsAxis(s))
                            }
                        }
                    }
                }
                .frame(height: CGFloat(timeInStatus.count) * 48 + 20)

                // Per-row summaries
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(displayData.rows, id: \.source.status) { row in
                        let box = row.source
                        HStack(spacing: 6) {
                            Text(box.status.rawValue)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                            Text("n=\(box.sampleCount)")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            if box.sampleCount == 0 {
                                Text("—")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            } else {
                                let median = formatMttmSeconds(box.p50) ?? "0s"
                                let p90str = formatMttmSeconds(box.p90) ?? "0s"
                                let maxStr = formatMttmSeconds(box.max) ?? "0s"
                                Text("median \(median) · p90 \(p90str) · max \(maxStr)")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }
    }

    private func formatSecondsAxis(_ s: Double) -> String {
        if s >= 3600 { return "\(Int(s / 3600))h" }
        if s >= 60 { return "\(Int(s / 60))m" }
        return "\(Int(s))s"
    }
}

// MARK: - Inline error banner

private struct ThroughputInlineErrorBanner: View {
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

// MARK: - Preview

#Preview("ThroughputDrillView — loading") {
    ThroughputDrillView(load: nil, onSelectPod: nil)
        .frame(width: 380, height: 700)
}
