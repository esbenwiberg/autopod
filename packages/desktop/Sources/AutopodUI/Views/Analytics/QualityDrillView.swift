import AutopodClient
import Charts
import SwiftUI

// MARK: - Band enum

enum QualityBand: String, CaseIterable {
    case all, red, yellow, green

    var label: String {
        switch self {
        case .all:    return "All"
        case .red:    return "Red <60"
        case .yellow: return "Yellow 60–79"
        case .green:  return "Green 80+"
        }
    }

    func matches(score: Int) -> Bool {
        switch self {
        case .all:    return true
        case .red:    return score < 60
        case .yellow: return score >= 60 && score < 80
        case .green:  return score >= 80
        }
    }
}

// MARK: - QualityDrillView

/// Right-pane drill for the Quality card — band chips, days picker, histogram,
/// reason tiles, and a filterable sortable scores table.
struct QualityDrillView: View {
    /// Called with the current `days` value when the view loads or days changes.
    let load: (Int) async throws -> QualityAnalyticsResponse
    let onSelectPod: ((String) -> Void)?

    @State private var response: QualityAnalyticsResponse?
    @State private var selectedBand: QualityBand = .all
    @State private var days: Int = 30
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var sortOrder: [KeyPathComparator<PodQualityScore>] = [
        KeyPathComparator(\.score, order: .reverse)
    ]

    // MARK: - Computed filtered state

    private var filteredScores: [PodQualityScore] {
        guard let r = response else { return [] }
        guard selectedBand != .all else { return r.scores }
        return r.scores.filter { selectedBand.matches(score: $0.score) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerRow

                if let err = loadError {
                    Text("Couldn't load quality data: \(err)")
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                if isLoading && response == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else if let r = response {
                    if r.summary.totalPodsScored == 0 {
                        Text("No completed pods scored in the last \(days) days.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    } else {
                        histogramSection(r)
                        Divider()
                        reasonTilesSection
                        Divider()
                        scoresTableSection
                    }
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await fetchData() }
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "speedometer")
                .foregroundStyle(.secondary)
            Text("Quality Analytics")
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
        .onChange(of: days) { _, _ in Task { await fetchData() } }
    }

    // MARK: - Band chips

    private var bandChips: some View {
        HStack(spacing: 6) {
            ForEach(QualityBand.allCases, id: \.self) { band in
                Button {
                    selectedBand = band
                } label: {
                    Text(band.label)
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(selectedBand == band
                                    ? bandChipColor(band).opacity(0.18)
                                    : Color(nsColor: .controlBackgroundColor))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .strokeBorder(
                                    selectedBand == band ? bandChipColor(band) : Color.clear,
                                    lineWidth: 1
                                )
                        )
                        .foregroundStyle(selectedBand == band ? bandChipColor(band) : Color.primary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func bandChipColor(_ band: QualityBand) -> Color {
        switch band {
        case .all:    return .primary
        case .red:    return .red
        case .yellow: return .yellow
        case .green:  return .green
        }
    }

    // MARK: - Histogram

    private func histogramSection(_ r: QualityAnalyticsResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Score Distribution")
                .font(.subheadline.weight(.semibold))
            Chart(r.distribution, id: \.bucket) { bucket in
                BarMark(
                    x: .value("Bucket", bucket.bucket),
                    y: .value("Count", bucket.count)
                )
                .foregroundStyle(analyticsScoreColor(bucketMidpoint(bucket.bucket)))
            }
            .chartXAxis {
                AxisMarks(values: .automatic) { _ in
                    AxisValueLabel()
                        .font(.caption2)
                }
            }
            .frame(height: 120)
        }
    }

    /// Maps a bucket label (e.g. "60-69") to its midpoint score for color coding.
    private func bucketMidpoint(_ bucket: String) -> Int {
        guard let lo = bucket.split(separator: "-").first.flatMap({ Int($0) }) else { return 50 }
        return lo + 5
    }

    // MARK: - Reason tiles

    private var reasonTilesSection: some View {
        let filtered = filteredScores  // computed once; shared with tile counts and table
        let total = filtered.count
        let reasons = selectedBand == .all
            ? (response?.reasons ?? QualityReasons(
                lowReadEditRatio: 0, editsWithoutPriorRead: 0,
                userInterrupts: 0, validationFailed: 0,
                prFixAttempts: 0, editChurn: 0, tells: 0))
            : reasonCounts(for: filtered)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Quality Signals")
                .font(.subheadline.weight(.semibold))
            bandChips
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 10)], spacing: 10) {
                reasonTile(label: "Low read/edit", count: reasons.lowReadEditRatio, total: total)
                reasonTile(label: "Edits w/o read", count: reasons.editsWithoutPriorRead, total: total)
                reasonTile(label: "User interrupts", count: reasons.userInterrupts, total: total)
                reasonTile(label: "Validation failed", count: reasons.validationFailed, total: total)
                reasonTile(label: "PR fix attempts", count: reasons.prFixAttempts, total: total)
                reasonTile(label: "Edit churn", count: reasons.editChurn, total: total)
                reasonTile(label: "Tells", count: reasons.tells, total: total)
            }
        }
    }

    private func reasonTile(label: String, count: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Text("\(count)")
                .font(.system(.title2, design: .rounded).weight(.bold))
            Text("of \(total) pod\(total == 1 ? "" : "s")")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Scores table

    private var scoresTableSection: some View {
        let rows = filteredScores.sorted(using: sortOrder)
        return VStack(alignment: .leading, spacing: 8) {
            Text("\(rows.count) pod\(rows.count == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.secondary)
            Table(rows, sortOrder: $sortOrder) {
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

    // MARK: - Fetch

    private func fetchData() async {
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await load(days)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    // MARK: - Reason recount (single pass, used when a band is selected)

    private func reasonCounts(for scores: [PodQualityScore]) -> QualityReasons {
        var lowReadEditRatio = 0, editsWithoutPriorRead = 0, userInterrupts = 0
        var validationFailed = 0, prFixAttempts = 0, editChurn = 0, tells = 0
        for s in scores {
            if s.readEditRatio < 1 && s.editCount > 0 { lowReadEditRatio += 1 }
            if s.editsWithoutPriorRead > 0 { editsWithoutPriorRead += 1 }
            if s.userInterrupts > 0 { userInterrupts += 1 }
            if s.validationPassed == false { validationFailed += 1 }
            if s.prFixAttempts > 0 { prFixAttempts += 1 }
            if s.editChurnCount > 0 { editChurn += 1 }
            if s.tellsCount > 0 { tells += 1 }
        }
        return QualityReasons(
            lowReadEditRatio: lowReadEditRatio,
            editsWithoutPriorRead: editsWithoutPriorRead,
            userInterrupts: userInterrupts,
            validationFailed: validationFailed,
            prFixAttempts: prFixAttempts,
            editChurn: editChurn,
            tells: tells
        )
    }
}

// MARK: - Preview

#Preview("QualityDrillView — loading") {
    QualityDrillView(
        load: { _ in try await Task.sleep(for: .seconds(60)); fatalError() },
        onSelectPod: nil
    )
    .frame(width: 700, height: 600)
}
