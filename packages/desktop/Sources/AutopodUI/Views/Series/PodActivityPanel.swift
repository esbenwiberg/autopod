import AutopodClient
import SwiftUI

/// Slide-in detail panel shown when a pipeline node is selected in `SeriesPipelineView`.
///
/// Sections (top → bottom):
///   - Header: pod id, status dot, navigate-↗ to make this pod the main detail.
///   - Meta row: status, duration, profile, model, cost.
///   - Phase progress bar (if `pod.phase` is set).
///   - Session Quality card (when `loadQuality` returns signals): grade dot + score
///     + 9 `StatTile`s covering interrupts, churn, tells, PR fixes, smoke tests,
///     browser checks, cost, blind edits, read/edit ratio.
///   - "Full validation →" link (when `requestTab` is wired).
///   - Activity feed: last 10 overview-worthy events with tap-to-expand detail.
///   - Action buttons: Nudge / Pause when active or attention-needed.
struct PodActivityPanel: View {
    let pod: Pod
    var events: [AgentEvent] = []
    var actions: PodActions
    var onNavigate: (() -> Void)?
    var loadQuality: ((String) async throws -> PodQualitySignals)? = nil
    var requestTab: ((DetailTab) -> Void)? = nil

    @State private var quality: PodQualitySignals? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            panelHeader
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    metaRow
                    if let phase = pod.phase {
                        phaseSection(phase)
                    }
                    if let q = quality {
                        SessionQualityCard(signals: q)
                        if let requestTab {
                            Button {
                                requestTab(.validation)
                            } label: {
                                HStack(spacing: 4) {
                                    Text("Full validation")
                                    Image(systemName: "arrow.right")
                                }
                                .font(.caption)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.blue)
                        }
                    }
                    ActivityFeedList(events: events, maxCount: 10)
                    if pod.status.isActive || pod.status.needsAttention {
                        actionButtons
                    }
                }
                .padding(12)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .task(id: pod.id) {
            await fetchQuality()
        }
    }

    private func fetchQuality() async {
        guard let loadQuality else { return }
        do {
            quality = try await loadQuality(pod.id)
        } catch {
            // Non-fatal: pod may have died early or daemon route may not be wired.
            quality = nil
        }
    }

    private var panelHeader: some View {
        HStack(spacing: 6) {
            StatusDot(status: pod.status)
            Text(pod.id)
                .font(.system(.callout, design: .monospaced).weight(.semibold))
                .lineLimit(1)
            Spacer()
            Button {
                onNavigate?()
            } label: {
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 13))
                    .foregroundStyle(.blue)
            }
            .buttonStyle(.plain)
            .help("Open pod detail")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var metaRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(pod.status.label)
                    .font(.caption)
                    .foregroundStyle(pod.status.color)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(pod.duration)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                Text(pod.profileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(pod.model)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if pod.costUsd > 0 {
                Text(String(format: "$%.2f", pod.costUsd))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func phaseSection(_ phase: PhaseProgress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Progress")
                .font(.system(.caption2).weight(.semibold))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
            ProgressView(value: Double(phase.current), total: Double(max(phase.total, 1)))
                .progressViewStyle(.linear)
                .tint(.blue)
            Text(phase.description)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var actionButtons: some View {
        HStack(spacing: 8) {
            if pod.status != .paused {
                Button("Nudge") {
                    Task { await actions.nudge(pod.id, "") }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            if pod.status.isActive {
                Button("Pause") {
                    Task { await actions.pause(pod.id) }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }
}
