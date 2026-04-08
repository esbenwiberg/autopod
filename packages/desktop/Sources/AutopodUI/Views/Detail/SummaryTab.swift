import SwiftUI

/// Summary tab — plan, task summary, deviations from plan, and original session prompt.
struct SummaryTab: View {
    let session: Session

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Plan
                if let plan = session.plan {
                    planCard(plan)
                }

                // Task summary (persistent once reported)
                if let summary = session.taskSummary {
                    taskSummaryCard(summary)
                }

                // Session prompt
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

            Text(plan.summary)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            if !plan.steps.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(index + 1).")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(width: 20, alignment: .trailing)
                            Text(step)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
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

            Text(summary.actualSummary)
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

    // MARK: - Session prompt

    private var promptSection: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "text.quote")
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            Text(session.task)
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
    SummaryTab(session: MockData.validated)
        .frame(width: 550, height: 600)
}

#Preview("Summary — running") {
    SummaryTab(session: MockData.running)
        .frame(width: 550, height: 400)
}
