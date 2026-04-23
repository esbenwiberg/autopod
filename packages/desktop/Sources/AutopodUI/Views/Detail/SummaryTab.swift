import MarkdownUI
import SwiftUI

/// Summary tab — plan, task summary, deviations from plan, and original pod prompt.
struct SummaryTab: View {
    let pod: Pod

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
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

                // Pod prompt
                promptSection
            }
            .padding(20)
        }
    }

    // MARK: - Plan

    private func planCard(_ plan: SessionPlan) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "list.bullet.clipboard")
                    .foregroundStyle(.blue)
                Text("Plan")
                    .font(.system(.subheadline).weight(.semibold))
            }

            Markdown(plan.summary)
                .markdownTheme(.autopod)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if !plan.steps.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(index + 1).")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(width: 20, alignment: .trailing)
                            Markdown(step)
                                .markdownTheme(.autopod)
                                .font(.caption)
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
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text.below.ecg")
                    .foregroundStyle(.indigo)
                Text("Task Summary")
                    .font(.system(.subheadline).weight(.semibold))
            }

            Markdown(summary.actualSummary)
                .markdownTheme(.autopod)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if !summary.deviations.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Deviations from Plan")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fontWeight(.semibold)

                    ForEach(Array(summary.deviations.enumerated()), id: \.offset) { _, deviation in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(deviation.step)
                                .font(.caption)
                                .fontWeight(.medium)
                            HStack(alignment: .top, spacing: 4) {
                                Text("Planned:")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text(deviation.planned)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            HStack(alignment: .top, spacing: 4) {
                                Text("Actual:")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text(deviation.actual)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text("Reason: \(deviation.reason)")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .italic()
                        }
                        .padding(8)
                        .background(Color.orange.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Proof of work

    private func proofOfWorkCard(_ shots: [PageScreenshot]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "photo.on.rectangle.angled")
                    .foregroundStyle(.green)
                Text("Proof of Work")
                    .font(.system(.subheadline).weight(.semibold))
                Text("\(shots.count) page\(shots.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 12) {
                ForEach(shots) { shot in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(shot.path)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                        screenshotThumbnail(shot.base64)
                    }
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Pod prompt

    private var promptSection: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "text.quote")
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            Markdown(pod.task)
                .markdownTheme(.autopod)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
            Spacer()
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
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
