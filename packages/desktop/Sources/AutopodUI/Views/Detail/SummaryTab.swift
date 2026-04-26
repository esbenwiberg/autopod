import AutopodClient
import MarkdownUI
import SwiftUI

/// Summary tab — plan, task summary, deviations from plan, and original pod prompt.
struct SummaryTab: View {
    let pod: Pod
    /// Optional closure for fetching session-quality signals. When nil
    /// (previews, tests without daemon), the quality card is simply hidden.
    var loadQuality: ((String) async throws -> PodQualitySignals)? = nil

    @State private var quality: PodQualitySignals? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Task brief — anchors everything else
                promptCard

                // Session quality — behavioural telemetry
                if let signals = quality {
                    SessionQualityCard(signals: signals)
                }

                // Plan
                if let plan = pod.plan {
                    planCard(plan)
                }

                // Task summary (persistent once reported)
                if let summary = pod.taskSummary {
                    taskSummaryCard(summary)
                }

                // Proof of work — smoke-page screenshots for web features
                if let shots = pod.validationChecks?.proofOfWorkScreenshots, !shots.isEmpty {
                    proofOfWorkCard(shots)
                }
            }
            .padding(20)
        }
        .task(id: pod.id) {
            await fetchQuality()
        }
    }

    // MARK: - Quality

    private func fetchQuality() async {
        guard let loadQuality else { return }
        do {
            quality = try await loadQuality(pod.id)
        } catch {
            quality = nil
        }
    }

    // MARK: - Prompt

    private var promptCard: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(Color.accentColor.opacity(0.5))
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: "text.quote")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    Text("Task")
                        .font(.system(.caption, design: .default).weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .tracking(0.3)
                }
                Markdown(pod.task)
                    .markdownTheme(.autopod)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.12), lineWidth: 1))
    }

    // MARK: - Plan

    private func planCard(_ plan: SessionPlan) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "list.bullet.clipboard")
                    .foregroundStyle(.blue)
                Text("Plan")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                if !plan.steps.isEmpty {
                    Text("\(plan.steps.count) step\(plan.steps.count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
            }

            if !plan.summary.isEmpty {
                Markdown(plan.summary)
                    .markdownTheme(.autopod)
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if !plan.steps.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 10) {
                            ZStack {
                                Circle()
                                    .fill(Color.blue.opacity(0.12))
                                    .frame(width: 22, height: 22)
                                Text("\(index + 1)")
                                    .font(.system(.caption2, design: .rounded).weight(.semibold))
                                    .foregroundStyle(.blue)
                            }
                            .padding(.top, 1)
                            Markdown(step)
                                .markdownTheme(.autopod)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Task summary

    private func taskSummaryCard(_ summary: TaskSummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text.below.ecg")
                    .foregroundStyle(.indigo)
                Text("Summary")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                if !summary.deviations.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 9))
                        Text("\(summary.deviations.count) deviation\(summary.deviations.count == 1 ? "" : "s")")
                            .font(.caption2)
                    }
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.orange.opacity(0.1), in: Capsule())
                }
            }

            Markdown(summary.actualSummary)
                .markdownTheme(.autopod)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if !summary.deviations.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Deviations from Plan")
                        .font(.system(.caption, design: .default).weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .tracking(0.3)

                    ForEach(Array(summary.deviations.enumerated()), id: \.offset) { _, deviation in
                        deviationCard(deviation)
                    }
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func deviationCard(_ deviation: DeviationItem) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(Color.orange.opacity(0.65))
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))

            VStack(alignment: .leading, spacing: 8) {
                Text(deviation.step)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)

                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("PLANNED")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .tracking(0.4)
                        Text(deviation.planned)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Image(systemName: "arrow.right")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 10)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("ACTUAL")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .tracking(0.4)
                        Text(deviation.actual)
                            .font(.caption)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Text(deviation.reason)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .italic()
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(Color.orange.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.orange.opacity(0.15), lineWidth: 1))
    }

    // MARK: - Proof of work

    private func proofOfWorkCard(_ shots: [PageScreenshot]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "photo.on.rectangle.angled")
                    .foregroundStyle(.green)
                Text("Proof of Work")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                Text("\(shots.count) page\(shots.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }

            let cols: [GridItem] = shots.count == 1
                ? [GridItem(.flexible())]
                : [GridItem(.flexible()), GridItem(.flexible())]

            LazyVGrid(columns: cols, spacing: 8) {
                ForEach(shots) { shot in
                    screenshotGridCell(shot)
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func screenshotGridCell(_ shot: PageScreenshot) -> some View {
        if let data = Data(base64Encoded: shot.base64),
           let nsImage = NSImage(data: data) {
            ZStack(alignment: .bottom) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 80, maxHeight: 200)
                    .clipped()
                Text(shot.path)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.55))
            }
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.2), lineWidth: 1))
        }
    }
}

// MARK: - Previews

#Preview("Summary — validated") {
    SummaryTab(pod: MockData.validated)
        .frame(width: 550, height: 600)
}

#Preview("Summary — running") {
    SummaryTab(pod: MockData.running)
        .frame(width: 550, height: 400)
}
