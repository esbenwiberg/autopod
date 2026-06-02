import AutopodClient
import SwiftUI

// MARK: - CostDrillView

/// Right-pane drill for the Cost card — fetches cost analytics and renders four sections.
struct CostDrillView: View {
    let loadCost: (() async throws -> CostAnalyticsResponse)?
    let onSelectPod: ((String) -> Void)?

    @State private var costData: CostAnalyticsResponse?
    @State private var costLoadError: String?
    @State private var isLoadingCost = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 8) {
                    Image(systemName: "dollarsign.circle")
                        .foregroundStyle(.secondary)
                    Text("Cost Analytics")
                        .font(.title3.weight(.semibold))
                    Spacer()
                    if isLoadingCost { ProgressView().controlSize(.small) }
                }

                if let err = costLoadError {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Text("Couldn't load cost data: \(err)")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Spacer()
                        Button("Retry") { Task { await fetchCost() } }
                            .font(.caption)
                            .disabled(isLoadingCost)
                    }
                    .padding(10)
                    .background(Color.red.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if let data = costData {
                    CostPhaseBarSectionView(byPhase: data.byPhase)
                    Divider()
                    CostProfileModelSectionView(byProfileModel: data.byProfileModel)
                    Divider()
                    CostTop10SectionView(top10: data.top10, onSelectPod: onSelectPod)
                    Divider()
                    CostWasteCalloutView(waste: data.waste)
                } else if isLoadingCost {
                    costLoadingSkeleton
                } else if costLoadError == nil && loadCost != nil {
                    Text("No completed pods in the last 30 days.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await fetchCost() }
    }

    private func fetchCost() async {
        guard let loadCost, !isLoadingCost else { return }
        isLoadingCost = true
        do {
            costData = try await loadCost()
            costLoadError = nil
        } catch {
            costLoadError = error.localizedDescription
        }
        isLoadingCost = false
    }

    private var costLoadingSkeleton: some View {
        VStack(alignment: .leading, spacing: 20) {
            skeletonFraction(0.4, height: 20)
            skeletonFull(height: 28)
            skeletonFraction(0.3, height: 16)
            skeletonFull(height: 80)
            skeletonFraction(0.3, height: 16)
            skeletonFull(height: 120)
        }
    }

    private func skeletonFull(height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(Color.secondary.opacity(0.12))
            .frame(maxWidth: .infinity)
            .frame(height: height)
    }

    private func skeletonFraction(_ fraction: CGFloat, height: CGFloat) -> some View {
        GeometryReader { geo in
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.secondary.opacity(0.12))
                .frame(width: geo.size.width * fraction, height: height)
        }
        .frame(height: height)
    }
}

// MARK: - CostPhaseBarSectionView

/// Stacked horizontal bar of cost by phase, plus a legend.
/// Uses custom path drawing — Charts framework is not a dependency.
private struct CostPhaseBarSectionView: View {
    let byPhase: [PhaseSegment]

    private static let colors: [String: Color] = [
        "agent_initial": .blue,
        "review": .orange,
        "plan_eval": .purple,
        "advisory": .pink,
        "agent_legacy": .gray,
    ]

    private func phaseColor(_ phase: String) -> Color {
        if let c = Self.colors[phase] { return c }
        if phase.hasPrefix("agent_rework_") { return .teal }
        return .secondary
    }

    /// Collapse agent_rework_N with N > 5 into "agent_rework_6+" when total > 7 segments.
    private var displaySegments: [PhaseSegment] {
        guard byPhase.count > 7 else { return byPhase }
        func isHighRework(_ phase: String) -> Bool {
            guard phase.hasPrefix("agent_rework_") else { return false }
            return Int(phase.dropFirst("agent_rework_".count)).map { $0 > 5 } ?? false
        }
        var result: [PhaseSegment] = []
        var collapsedCost = 0.0
        for seg in byPhase {
            if isHighRework(seg.phase) {
                collapsedCost += seg.costUsd
            } else {
                result.append(seg)
            }
        }
        if collapsedCost > 0 {
            let insertAt = result.lastIndex(where: { $0.phase.hasPrefix("agent_rework_") })
                .map { $0 + 1 }
                ?? result.firstIndex(where: { $0.phase != "agent_initial" })
                ?? result.count
            result.insert(PhaseSegment(phase: "agent_rework_6+", costUsd: collapsedCost), at: insertAt)
        }
        return result
    }

    var body: some View {
        let segments = displaySegments
        let total = segments.reduce(0.0) { $0 + $1.costUsd }
        VStack(alignment: .leading, spacing: 12) {
            Text("Cost by Phase")
                .font(.headline)

            if total > 0 {
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        ForEach(segments, id: \.phase) { seg in
                            Rectangle()
                                .fill(phaseColor(seg.phase))
                                .frame(width: max(CGFloat(seg.costUsd / total) * geo.size.width, 1))
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .frame(height: 24)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], spacing: 6) {
                    ForEach(segments, id: \.phase) { seg in
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(phaseColor(seg.phase))
                                .frame(width: 10, height: 10)
                            Text(seg.phase)
                                .font(.system(.caption, design: .monospaced))
                                .lineLimit(1)
                            Spacer()
                            Text(String(format: "$%.2f", seg.costUsd))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text("No phase data.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - CostProfileModelSectionView

/// Profile × model cost matrix — rows are profiles, columns are models.
private struct CostProfileModelSectionView: View {
    let byProfileModel: [ProfileModelCell]

    private var models: [String] {
        Array(Set(byProfileModel.map { $0.model ?? "—" })).sorted()
    }

    private var profiles: [String] {
        Array(Set(byProfileModel.map(\.profile))).sorted()
    }

    /// O(1) lookup pre-built from byProfileModel.
    private var cellMap: [String: [String: ProfileModelCell]] {
        var map: [String: [String: ProfileModelCell]] = [:]
        for c in byProfileModel {
            let modelKey = c.model ?? "—"
            map[c.profile, default: [:]][modelKey] = c
        }
        return map
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Cost by Profile & Model")
                .font(.headline)

            if byProfileModel.isEmpty {
                Text("No profile / model data.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                let map = cellMap
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyVGrid(
                        columns: [GridItem(.fixed(160))] + models.map { _ in GridItem(.fixed(110)) },
                        alignment: .leading,
                        spacing: 6
                    ) {
                        Text("Profile")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(models, id: \.self) { model in
                            Text(model)
                                .font(.system(.caption, design: .monospaced).weight(.semibold))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }

                        ForEach(profiles, id: \.self) { profile in
                            Text(profile)
                                .font(.system(.caption).weight(.medium))
                                .lineLimit(1)
                            ForEach(models, id: \.self) { model in
                                if let c = map[profile]?[model] {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(String(format: "$%.2f", c.costUsd))
                                            .font(.system(.caption, design: .monospaced).weight(.semibold))
                                        Text("\(c.podCount) pod\(c.podCount == 1 ? "" : "s")")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                } else {
                                    Text("—")
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    .padding(2) // prevent clipping of focus rings at scroll edges
                }
            }
        }
    }
}

// MARK: - CostTop10SectionView

/// Top-10 most expensive pods — tappable rows that navigate to the pod.
private struct CostTop10SectionView: View {
    let top10: [TopPodEntry]
    let onSelectPod: ((String) -> Void)?

    private func statusColor(_ status: String) -> Color {
        PodStatus(rawValue: status)?.color ?? (status == "rejected" ? .orange : .secondary)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Top 10 Most Expensive")
                .font(.headline)

            if top10.isEmpty {
                Text("No pods in window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(top10, id: \.podId) { entry in
                        Button {
                            onSelectPod?(entry.podId)
                        } label: {
                            podRow(entry)
                        }
                        .buttonStyle(.plain)

                        if entry.podId != top10.last?.podId {
                            Divider().padding(.leading, 12)
                        }
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func podRow(_ entry: TopPodEntry) -> some View {
        HStack(spacing: 10) {
            Text(String(entry.podId.prefix(8)))
                .font(.system(.caption, design: .monospaced).weight(.medium))
                .foregroundStyle(.primary)

            Text(entry.profile)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(.secondary)

            if let model = entry.model {
                Text(model)
                    .font(.system(.caption2, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            Text(entry.finalStatus)
                .font(.system(.caption2).weight(.medium))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(statusColor(entry.finalStatus).opacity(0.08))
                .foregroundStyle(statusColor(entry.finalStatus).opacity(0.85))
                .clipShape(RoundedRectangle(cornerRadius: 4))

            Text(String(format: "$%.2f", entry.costUsd))
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .monospacedDigit()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

// MARK: - CostWasteCalloutView

/// Passive callout card showing strict-waste cost (killed / failed / rejected pods).
private struct CostWasteCalloutView: View {
    let waste: WasteSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Cost waste")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            Text(String(format: "$%.2f", waste.total))
                .font(.largeTitle.bold())
            Text("across \(waste.podCount) pod\(waste.podCount == 1 ? "" : "s")")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text("Pods that ended killed, failed, or rejected")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(0.03), radius: 3, y: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.white.opacity(0.15), lineWidth: 1.5)
        )
    }
}
