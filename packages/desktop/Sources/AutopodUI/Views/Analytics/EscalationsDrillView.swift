import AutopodClient
import Charts
import SwiftUI

// MARK: - EscalationsDrillView

/// Right-pane drill for the Escalations card — three sections:
/// 1. ask_human time-to-respond histogram (8 log-scale buckets)
/// 2. Per-profile escalation rate table
/// 3. Blocker patterns table (expandable rows with pod-id chips)
struct EscalationsDrillView: View {
    let load: ((Int) async throws -> EscalationsAnalyticsResponse)?
    let onSelectPod: ((String) -> Void)?

    @State private var response: EscalationsAnalyticsResponse?
    @State private var days: Int = 30
    @State private var isLoading = false
    @State private var loadError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerRow

                if let err = loadError {
                    EscalationsInlineErrorBanner(message: "Couldn't load escalations data: \(err)")
                }

                if isLoading && response == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else {
                    ttrHistogramSection
                    Divider()
                    perProfileSection
                    Divider()
                    blockerPatternsSection
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
            Image(systemName: "person.2.wave.2")
                .foregroundStyle(.secondary)
            Text("Escalations Analytics")
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

    // MARK: - Section 1: ask_human TTR histogram

    private var ttrHistogramSection: some View {
        EscalationsTtrSectionView(ttr: response?.askHumanTtr, days: days)
    }

    // MARK: - Section 2: Per-profile table

    private var perProfileSection: some View {
        EscalationsPerProfileSectionView(perProfile: response?.perProfile ?? [], days: days)
    }

    // MARK: - Section 3: Blocker patterns

    private var blockerPatternsSection: some View {
        EscalationsBlockerPatternsSectionView(
            patterns: response?.blockerPatterns ?? [],
            days: days,
            onSelectPod: onSelectPod
        )
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

// MARK: - Section 1: TTR histogram

private struct EscalationsTtrSectionView: View {
    let ttr: AskHumanTtr?
    let days: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("ask_human Response Time")
                    .font(.headline)
                Spacer()
                if let ttr {
                    Text("\(ttr.resolvedCount) resolved \u{00B7} \(ttr.openCount) open")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let ttr {
                if ttr.resolvedCount == 0 {
                    Text("No ask_human escalations resolved in last \(days) days.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Chart {
                        ForEach(ttr.buckets, id: \.label) { bucket in
                            BarMark(
                                x: .value("Bucket", bucket.label),
                                y: .value("Count", bucket.count)
                            )
                            .foregroundStyle(Color.accentColor.opacity(0.75))
                            .annotation(position: .top, alignment: .center) {
                                if bucket.count > 0 {
                                    Text("\(bucket.count)")
                                        .font(.system(size: 9, weight: .medium))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .chartXAxis {
                        AxisMarks { _ in
                            AxisValueLabel()
                                .font(.system(size: 9))
                        }
                    }
                    .frame(height: 140)

                    if ttr.maxSeconds > 0 {
                        Text("max: \(formatEscalationDuration(ttr.maxSeconds))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }
}

// MARK: - Section 2: Per-profile table

private struct EscalationsPerProfileSectionView: View {
    let perProfile: [PerProfileEscalation]
    let days: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Per-Profile Escalation Rate")
                .font(.headline)

            if perProfile.isEmpty {
                Text("No terminal pods in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                // Column headers
                HStack(spacing: 0) {
                    Text("Profile")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("Pods")
                        .frame(width: 50, alignment: .trailing)
                    Text("Escalated")
                        .frame(width: 70, alignment: .trailing)
                    Text("Rate")
                        .frame(width: 55, alignment: .trailing)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)

                Divider()

                ForEach(perProfile, id: \.profile) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 0) {
                            Text(row.profile)
                                .font(.body)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text("\(row.podCount)")
                                .font(.system(.body, design: .monospaced).weight(.medium))
                                .frame(width: 50, alignment: .trailing)
                                .foregroundStyle(.secondary)
                            Text("\(row.escalatedCount)")
                                .font(.system(.body, design: .monospaced).weight(.medium))
                                .frame(width: 70, alignment: .trailing)
                                .foregroundStyle(.secondary)
                            Text("\(Int(round(row.rate * 100)))%")
                                .font(.system(.body, design: .monospaced).weight(.medium))
                                .frame(width: 55, alignment: .trailing)
                        }
                        if row.profile == "<small profiles>" {
                            Text("small profiles")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 4)
                    Divider()
                }
            }
        }
    }
}

// MARK: - Section 3: Blocker patterns

private struct EscalationsBlockerPatternsSectionView: View {
    let patterns: [BlockerPattern]
    let days: Int
    let onSelectPod: ((String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Top Blocker Patterns")
                .font(.headline)

            if patterns.isEmpty {
                Text("No report_blocker escalations in last \(days) days.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(patterns, id: \.description) { pattern in
                    BlockerPatternRow(pattern: pattern, onSelectPod: onSelectPod)
                    Divider()
                }
            }
        }
    }
}

private struct BlockerPatternRow: View {
    let pattern: BlockerPattern
    let onSelectPod: ((String) -> Void)?

    @State private var isExpanded = false

    private var overflow: Int { pattern.count - pattern.podIds.count }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 4) {
                Text(pattern.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)

                ForEach(pattern.podIds, id: \.self) { podId in
                    Button {
                        onSelectPod?(podId)
                    } label: {
                        Text(podId)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.blue)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(Color.blue.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    .buttonStyle(.plain)
                }

                if overflow > 0 {
                    Text("+ \(overflow) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 4)
        } label: {
            HStack {
                Text(pattern.description)
                    .font(.body)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("\(pattern.count)")
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Inline error banner

private struct EscalationsInlineErrorBanner: View {
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

// MARK: - Duration formatter

/// Formats seconds as "Xh Ym", "Ym Zs", "Ym", or "Xs". Returns "—" for 0.
private func formatEscalationDuration(_ secs: Double) -> String {
    guard secs > 0 else { return "—" }
    let total = Int(secs)
    if total >= 3600 {
        let h = total / 3600
        let m = (total % 3600) / 60
        return m > 0 ? "\(h)h \(m)m" : "\(h)h"
    } else if total >= 60 {
        let m = total / 60
        let s = total % 60
        return s > 0 ? "\(m)m \(s)s" : "\(m)m"
    } else {
        return "\(total)s"
    }
}

// MARK: - Preview

#Preview("EscalationsDrillView — loading") {
    EscalationsDrillView(load: nil, onSelectPod: nil)
        .frame(width: 380, height: 700)
}
