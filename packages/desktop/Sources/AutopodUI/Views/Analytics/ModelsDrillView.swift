import AutopodClient
import Charts
import SwiftUI

// MARK: - ModelsDrillView

/// Right-pane drill for the Models card — three sections:
/// 1. Leaderboard table (model · pods · success rate · $/PR · avg quality · mean TTM · escalation rate)
/// 2. Side-by-side comparison panel (5 horizontal bar charts)
/// 3. Failure-stage matrix (model rows × 8 stage columns)
struct ModelsDrillView: View {
    let load: ((Int) async throws -> ModelsAnalyticsResponse)?

    @State private var response: ModelsAnalyticsResponse?
    @State private var days: Int = 30
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var grain: Grain = .model

    enum Grain { case model, runtime }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerRow

                if let err = loadError {
                    ModelsInlineErrorBanner(message: "Couldn't load models data: \(err)")
                }

                if isLoading && response == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else {
                    leaderboardSection
                    Divider()
                    comparisonSection
                    Divider()
                    failureMatrixSection
                    Divider()
                    simulatorSection
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
            Image(systemName: "cpu")
                .foregroundStyle(.secondary)
            Text("Models Analytics")
                .font(.title3.weight(.semibold))
            Spacer()
            if isLoading { ProgressView().controlSize(.small) }
            grainPicker
            daysPicker
        }
    }

    private var grainPicker: some View {
        Picker("Grain", selection: $grain) {
            Text("Model").tag(Grain.model)
            Text("Runtime").tag(Grain.runtime)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 130)
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

    // MARK: - Section 1: Leaderboard

    private var leaderboardSection: some View {
        ModelsLeaderboardSectionView(
            rows: leaderboardRows,
            days: days,
            grain: grain
        )
    }

    private var leaderboardRows: [LeaderboardRow] {
        guard let r = response else { return [] }
        switch grain {
        case .model:
            return r.byModel.map { m in
                LeaderboardRow(
                    id: m.model,
                    label: m.model,
                    podCount: m.podCount,
                    successRate: m.successRate,
                    dollarPerPr: m.dollarPerPr,
                    avgQuality: m.avgQuality,
                    meanTtmSeconds: m.meanTtmSeconds,
                    escalationRate: m.escalationRate
                )
            }
        case .runtime:
            return r.byRuntime.map { rt in
                LeaderboardRow(
                    id: rt.runtime.rawValue,
                    label: rt.runtime.rawValue,
                    podCount: rt.podCount,
                    successRate: rt.successRate,
                    dollarPerPr: rt.dollarPerPr,
                    avgQuality: rt.avgQuality,
                    meanTtmSeconds: rt.meanTtmSeconds,
                    escalationRate: rt.escalationRate
                )
            }
        }
    }

    // MARK: - Section 2: Comparison panel

    private var comparisonSection: some View {
        ModelsComparisonSectionView(rows: leaderboardRows, days: days)
    }

    // MARK: - Section 3: Failure-stage matrix (always model grain)

    private var failureMatrixSection: some View {
        ModelsFailureMatrixSectionView(
            matrix: response?.failureStageMatrix ?? [],
            days: days
        )
    }

    // MARK: - Section 4: What-if simulator

    private var simulatorSection: some View {
        // Use .id() keyed on the eligible model names so @State inside WhatIfSimulatorSection
        // resets to defaults when the data changes (days picker → refetch → new eligible set).
        WhatIfSimulatorSection(byModel: response?.byModel ?? [])
            .id(simulatorEligibleKey)
    }

    private var simulatorEligibleKey: String {
        (response?.byModel ?? [])
            .filter(\.isSimulatorEligible)
            .map(\.model)
            .joined(separator: ",")
    }

    // MARK: - Fetch

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

// MARK: - Section 4: What-if simulator view

private struct WhatIfSimulatorSection: View {
    let byModel: [PerModelAggregate]

    // Source dropdown: most-used first so the operator sees their workhorse model at the top.
    private var eligibleByUsage: [PerModelAggregate] {
        byModel.filter(\.isSimulatorEligible).sorted { $0.podCount > $1.podCount }
    }

    // Target dropdown: cheapest first so the default is the cost-saving candidate.
    private var eligibleByPrice: [PerModelAggregate] {
        byModel.filter(\.isSimulatorEligible)
            .sorted { ($0.dollarPerPr ?? .greatestFiniteMagnitude) < ($1.dollarPerPr ?? .greatestFiniteMagnitude) }
    }

    @State private var sourceModelName: String = ""
    @State private var targetModelName: String = ""
    @State private var redirectPct: Int = 0

    // Fall back to first/second eligible row before onAppear fires.
    private var source: PerModelAggregate? {
        eligibleByUsage.first { $0.model == sourceModelName } ?? eligibleByUsage.first
    }
    private var target: PerModelAggregate? {
        eligibleByUsage.first { $0.model == targetModelName }
            ?? eligibleByUsage.first { $0.model != (source?.model ?? "") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What-If Simulator")
                .font(.headline)

            let eligible = eligibleByUsage
            if eligible.count < 2 {
                Text("Need ≥2 models with priced cohort pods to simulate.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                caveatsView
                controlsView
                if let src = source, let tgt = target, src.model != tgt.model {
                    projectionTableView(source: src, target: tgt)
                }
            }
        }
        .onAppear { initDefaults() }
    }

    // MARK: Caveat banner — copy is verbatim from ADR-023 (do not soften without updating the ADR).

    private var caveatsView: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Naïve projection — assumes target model performs identically to its past terminal-cohort pods. Validate before committing.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: Controls

    private var controlsView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Redirect from")
                    .frame(width: 110, alignment: .leading)
                Picker("Source", selection: $sourceModelName) {
                    ForEach(eligibleByUsage, id: \.model) { row in
                        Text(row.model).tag(row.model)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .onChange(of: sourceModelName) { _, newSource in
                    // Source-Target invariant: auto-advance target when it matches new source.
                    if targetModelName == newSource {
                        targetModelName = eligibleByUsage.first { $0.model != newSource }?.model ?? targetModelName
                    }
                }
            }

            HStack {
                Text("Redirect to")
                    .frame(width: 110, alignment: .leading)
                Picker("Target", selection: $targetModelName) {
                    ForEach(eligibleByPrice, id: \.model) { row in
                        Text(row.model).tag(row.model)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
            }

            HStack {
                Text("Redirect")
                    .frame(width: 110, alignment: .leading)
                Slider(
                    value: Binding(get: { Double(redirectPct) }, set: { redirectPct = Int($0) }),
                    in: 0...100,
                    step: 1
                )
                Text("\(redirectPct)%")
                    .monospacedDigit()
                    .frame(width: 36, alignment: .trailing)
            }
        }
    }

    // MARK: Projection table

    private func projectionTableView(source: PerModelAggregate, target: PerModelAggregate) -> some View {
        let fraction = Double(redirectPct) / 100.0
        let eligible = eligibleByUsage
        let current = projectFleet(byModel: eligible, source: source, target: target, redirectFraction: 0)
        let projected = projectFleet(byModel: eligible, source: source, target: target, redirectFraction: fraction)

        return VStack(alignment: .leading, spacing: 0) {
            tableHeader
            Divider()
            tableRow("$/PR",
                     current: current.dollarPerPr.map { String(format: "$%.2f", $0) } ?? "—",
                     projected: projected.dollarPerPr.map { String(format: "$%.2f", $0) } ?? "—",
                     delta: dollarDelta(current.dollarPerPr, projected.dollarPerPr))
            Divider()
            tableRow("Avg quality",
                     current: current.avgQuality.map { "\(Int(round($0)))" } ?? "—",
                     projected: projected.avgQuality.map { "\(Int(round($0)))" } ?? "—",
                     delta: intDelta(current.avgQuality, projected.avgQuality))
            Divider()
            tableRow("Success rate",
                     current: pctStr(current.successRate),
                     projected: pctStr(projected.successRate),
                     delta: ppDelta(current.successRate, projected.successRate))
            Divider()
            tableRow("Mean TTM",
                     current: current.meanTtmSeconds.flatMap { formatMttmSeconds($0) } ?? "—",
                     projected: projected.meanTtmSeconds.flatMap { formatMttmSeconds($0) } ?? "—",
                     delta: ttmDelta(current.meanTtmSeconds, projected.meanTtmSeconds))
            Divider()
            tableRow("Escalation rate",
                     current: pctStr(current.escalationRate),
                     projected: pctStr(projected.escalationRate),
                     delta: ppDelta(current.escalationRate, projected.escalationRate))
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var tableHeader: some View {
        HStack(spacing: 0) {
            Text("Axis").frame(maxWidth: .infinity, alignment: .leading)
            Text("Current").frame(width: 80, alignment: .trailing)
            Text("Projected").frame(width: 80, alignment: .trailing)
            Text("Delta").frame(width: 72, alignment: .trailing)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func tableRow(_ axis: String, current: String, projected: String, delta: String) -> some View {
        HStack(spacing: 0) {
            Text(axis).frame(maxWidth: .infinity, alignment: .leading)
            Text(current).monospacedDigit().frame(width: 80, alignment: .trailing)
            Text(projected).monospacedDigit().frame(width: 80, alignment: .trailing)
            Text(delta).monospacedDigit().foregroundStyle(.secondary).frame(width: 72, alignment: .trailing)
        }
        .font(.body)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Delta formatters
    // Delta is neutral — no red/green colouring because the goodness of a sign varies per axis.

    private func dollarDelta(_ c: Double?, _ p: Double?) -> String {
        guard let c, let p else { return "—" }
        return String(format: "%+.2f/PR", p - c)
    }

    private func intDelta(_ c: Double?, _ p: Double?) -> String {
        guard let c, let p else { return "—" }
        let d = Int(round(p)) - Int(round(c))
        return d >= 0 ? "+\(d)" : "\(d)"
    }

    private func ppDelta(_ c: Double, _ p: Double) -> String {
        let d = Int(round(p * 100)) - Int(round(c * 100))
        return d >= 0 ? "+\(d)pp" : "\(d)pp"
    }

    private func ttmDelta(_ c: Double?, _ p: Double?) -> String {
        guard let c, let p else { return "—" }
        let secs = p - c
        if abs(secs) < 60 { return String(format: "%+.0fs", secs) }
        let mins = Int(secs / 60)
        return mins >= 0 ? "+\(mins)m" : "\(mins)m"
    }

    private func pctStr(_ v: Double) -> String { "\(Int(round(v * 100)))%" }

    // MARK: State init

    private func initDefaults() {
        let byUsage = eligibleByUsage
        let byPrice = eligibleByPrice
        guard byUsage.count >= 2 else { return }

        let defaultSource = byUsage[0].model
        sourceModelName = defaultSource

        // Default target: cheapest eligible; auto-advance past source if needed.
        targetModelName = byPrice.first { $0.model != defaultSource }?.model ?? byUsage[1].model
        redirectPct = 0
    }
}

// MARK: - Shared leaderboard row

private struct LeaderboardRow: Identifiable {
    let id: String
    let label: String
    let podCount: Int
    let successRate: Double
    let dollarPerPr: Double?
    let avgQuality: Double?
    let meanTtmSeconds: Double?
    let escalationRate: Double
}

// MARK: - Section 1: Leaderboard table

private struct ModelsLeaderboardSectionView: View {
    let rows: [LeaderboardRow]
    let days: Int
    let grain: ModelsDrillView.Grain

    // MIN_COHORT_FOR_HEADLINE mirrors the daemon constant (models-aggregator.ts).
    private let minCohort = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Leaderboard")
                .font(.headline)

            if rows.isEmpty {
                Text("No terminal pods in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                columnHeaders
                Divider()
                ForEach(rows) { row in
                    leaderboardRow(row)
                    Divider()
                }
            }
        }
    }

    private var columnHeaders: some View {
        HStack(spacing: 0) {
            Text(grain == .model ? "Model" : "Runtime")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Pods")
                .frame(width: 55, alignment: .trailing)
            Text("Success")
                .frame(width: 60, alignment: .trailing)
            Text("$/PR")
                .frame(width: 58, alignment: .trailing)
            Text("Quality")
                .frame(width: 58, alignment: .trailing)
            Text("TTM")
                .frame(width: 60, alignment: .trailing)
            Text("Esc%")
                .frame(width: 48, alignment: .trailing)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }

    private func leaderboardRow(_ row: LeaderboardRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 0) {
                Text(row.label)
                    .font(.body)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("\(row.podCount)")
                    .monospacedDigit()
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .frame(width: 55, alignment: .trailing)
                    .foregroundStyle(.secondary)
                Text("\(Int(round(row.successRate * 100)))%")
                    .monospacedDigit()
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .frame(width: 60, alignment: .trailing)
                    .foregroundStyle(.secondary)
                Text(row.dollarPerPr.map { String(format: "$%.2f", $0) } ?? "—")
                    .monospacedDigit()
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .frame(width: 58, alignment: .trailing)
                    .foregroundStyle(.secondary)
                Text(row.avgQuality.map { "\(Int(round($0)))" } ?? "—")
                    .monospacedDigit()
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .frame(width: 58, alignment: .trailing)
                    .foregroundStyle(.secondary)
                Text(row.meanTtmSeconds.flatMap { formatMttmSeconds($0) } ?? "—")
                    .monospacedDigit()
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .frame(width: 60, alignment: .trailing)
                    .foregroundStyle(.secondary)
                Text("\(Int(round(row.escalationRate * 100)))%")
                    .monospacedDigit()
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .frame(width: 48, alignment: .trailing)
                    .foregroundStyle(.secondary)
            }
            if row.podCount < minCohort {
                Text("\(row.podCount) pods — low-signal")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
    }
}

// MARK: - Section 2: Comparison panel

private struct ModelsComparisonSectionView: View {
    let rows: [LeaderboardRow]
    let days: Int

    // Stable palette keyed by row position in the server-supplied order.
    private let palette: [Color] = [
        .blue, .green, .orange, .purple, .red, .teal, .indigo, .mint,
    ]

    private func color(at index: Int) -> Color {
        palette[index % palette.count]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Comparison")
                .font(.headline)

            if rows.isEmpty || rows.allSatisfy({ $0.podCount == 0 }) {
                Text("No comparable models in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                axisChart(title: "Success Rate", keyPath: \.successRate, format: { "\(Int(round($0 * 100)))%" })
                axisChart(
                    title: "$/PR",
                    items: rows.enumerated().compactMap { i, r in r.dollarPerPr.map { (r, i, $0) } },
                    format: { String(format: "$%.2f", $0) }
                )
                axisChart(title: "Avg Quality", keyPath: \.avgQuality, format: { "\(Int(round($0)))" })
                axisChart(title: "Mean TTM", keyPath: \.meanTtmSeconds, format: { formatMttmSeconds($0) ?? "—" })
                axisChart(title: "Escalation Rate", keyPath: \.escalationRate, format: { "\(Int(round($0 * 100)))%" })

                legendView
            }
        }
    }

    /// Chart for axes where the keyPath returns a non-optional Double.
    private func axisChart(
        title: String,
        keyPath: KeyPath<LeaderboardRow, Double>,
        format: (Double) -> String
    ) -> some View {
        axisChart(
            title: title,
            items: rows.enumerated().map { i, r in (r, i, r[keyPath: keyPath]) },
            format: format
        )
    }

    /// Chart for axes where the value may be nil (e.g. $/PR for <unknown>).
    private func axisChart(
        title: String,
        keyPath: KeyPath<LeaderboardRow, Double?>,
        format: (Double) -> String
    ) -> some View {
        axisChart(
            title: title,
            items: rows.enumerated().compactMap { i, r in r[keyPath: keyPath].map { (r, i, $0) } },
            format: format
        )
    }

    private func axisChart(
        title: String,
        items: [(LeaderboardRow, Int, Double)],
        format: (Double) -> String
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)

            if items.isEmpty {
                Text("—")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                Chart(items, id: \.0.id) { row, idx, value in
                    BarMark(
                        x: .value("Value", value),
                        y: .value("Label", row.label)
                    )
                    .foregroundStyle(color(at: idx))
                    .annotation(position: .trailing, alignment: .leading) {
                        Text(format(value))
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
                .chartYAxis {
                    AxisMarks { _ in
                        AxisValueLabel()
                            .font(.system(size: 10))
                    }
                }
                .frame(height: CGFloat(items.count) * 28 + 10)
            }
        }
    }

    private var legendView: some View {
        FlowLayout(spacing: 8) {
            ForEach(rows.indices, id: \.self) { i in
                HStack(spacing: 4) {
                    Circle()
                        .fill(color(at: i))
                        .frame(width: 8, height: 8)
                    Text(rows[i].label)
                        .font(.caption)
                        .lineLimit(1)
                }
            }
        }
    }
}

/// Simple horizontal wrapping layout for the legend.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxY: CGFloat = 0

        for sv in subviews {
            let size = sv.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            maxY = y + rowHeight
        }
        return CGSize(width: width, height: maxY)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for sv in subviews {
            let size = sv.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            sv.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }
}

// MARK: - Section 3: Failure-stage matrix

private let modelsStageOrder: [ValidationStage] = [
    .build, .health, .smoke, .test, .lint, .sast, .acValidation, .taskReview,
]

private struct ModelsFailureMatrixSectionView: View {
    let matrix: [ModelsFailureStageRow]
    let days: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Failure-Stage Matrix")
                .font(.headline)

            if matrix.isEmpty {
                Text("No validations ran on any model in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                matrixHeader
                Divider()
                ForEach(matrix, id: \.model) { row in
                    matrixRow(row)
                    Divider()
                }
            }
        }
    }

    private var matrixHeader: some View {
        HStack(spacing: 4) {
            Text("Model")
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(modelsStageOrder, id: \.self) { stage in
                Text(stage.shortLabel)
                    .frame(width: 44, alignment: .center)
            }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }

    private func matrixRow(_ row: ModelsFailureStageRow) -> some View {
        HStack(spacing: 4) {
            Text(row.model)
                .font(.body)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(modelsStageOrder, id: \.self) { stage in
                stageCell(in: row, stage: stage)
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 4)
    }

    private func stageCell(in row: ModelsFailureStageRow, stage: ValidationStage) -> some View {
        Group {
            if let cell = row.stages.first(where: { $0.stage == stage }), cell.podsRan > 0 {
                VStack(spacing: 1) {
                    Text("\(cell.podsFailed)/\(cell.podsRan)")
                        .font(.system(size: 9))
                }
                .frame(width: 44, minHeight: 32)
                .background(stageCellBackground(failureRate: cell.failureRate))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                Text("—")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .frame(width: 44, minHeight: 32)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        }
    }
}

/// Linear interpolation neutral→red across [0, 1]. Peak opacity 0.85 at failureRate == 1.0
/// keeps fully-failing cells visually distinct from cells near-but-below 1.0 (the brief warns
/// against saturating earlier — a single failing pod must not look identical to a uniformly
/// failing model).
private func stageCellBackground(failureRate: Double) -> Color {
    Color.red.opacity(failureRate * 0.85)
}

// MARK: - ValidationStage short label for column headers

private extension ValidationStage {
    var shortLabel: String {
        switch self {
        case .build:        return "build"
        case .health:       return "health"
        case .smoke:        return "smoke"
        case .test:         return "test"
        case .lint:         return "lint"
        case .sast:         return "sast"
        case .acValidation: return "acVal"
        case .taskReview:   return "review"
        }
    }
}

// MARK: - Inline error banner

private struct ModelsInlineErrorBanner: View {
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

#Preview("ModelsDrillView — loading") {
    ModelsDrillView(load: nil)
        .frame(width: 480, height: 800)
}
