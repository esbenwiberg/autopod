import AutopodClient
import MarkdownUI
import SwiftUI

/// Work tab — task, plan, task summary, deviations from plan, and quality signals.
struct WorkTab: View {
    let pod: Pod
    /// Optional closure for fetching session-quality signals. When nil
    /// (previews, tests without daemon), the quality card is simply hidden.
    var loadQuality: ((String) async throws -> PodQualitySignals)? = nil

    @State private var quality: PodQualitySignals? = nil
    @State private var selectedSection: WorkSection = .task

    private enum WorkSection: String, CaseIterable {
        case task, plan, summary, deviations, quality

        var label: String {
            switch self {
            case .task: "Task"
            case .plan: "Plan"
            case .summary: "Summary"
            case .deviations: "Deviations"
            case .quality: "Quality"
            }
        }

        var icon: String {
            switch self {
            case .task: "text.quote"
            case .plan: "list.bullet.clipboard"
            case .summary: "doc.text.below.ecg"
            case .deviations: "exclamationmark.triangle"
            case .quality: "gauge.with.dots.needle.67percent"
            }
        }
    }

    var body: some View {
        HSplitView {
            sectionRail
                .frame(minWidth: 150, idealWidth: 170, maxWidth: 220)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    selectedSectionContent
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: pod.id) {
            await fetchQuality()
        }
        .onAppear {
            selectedSection = defaultSection
        }
        .onChange(of: pod.id) { _, _ in
            selectedSection = defaultSection
        }
    }

    private var defaultSection: WorkSection {
        pod.taskSummary == nil ? .task : .summary
    }

    private var sectionRail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Work")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .tracking(0.4)
                .padding(.horizontal, 12)
                .padding(.top, 12)

            ForEach(WorkSection.allCases, id: \.self) { section in
                Button {
                    selectedSection = section
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: section.icon)
                            .font(.system(size: 12))
                            .frame(width: 16)
                        Text(section.label)
                            .font(.subheadline.weight(selectedSection == section ? .semibold : .regular))
                        Spacer(minLength: 0)
                        if section == .deviations, let count = pod.taskSummary?.deviations.count, count > 0 {
                            Text("\(count)")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }
                    .foregroundStyle(selectedSection == section ? .primary : .secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 7)
                            .fill(selectedSection == section ? Color.white.opacity(0.08) : .clear)
                    )
                    .contentShape(RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
    }

    @ViewBuilder
    private var selectedSectionContent: some View {
        switch selectedSection {
        case .task:
            promptCard
        case .plan:
            if let plan = pod.plan {
                planCard(plan)
            } else {
                emptyWorkSection("No plan reported yet", icon: "list.bullet.clipboard")
            }
        case .summary:
            if let summary = pod.taskSummary {
                taskSummaryCard(summary, includeDeviations: false)
            } else {
                emptyWorkSection("No task summary reported yet", icon: "doc.text.below.ecg")
            }
        case .deviations:
            if let summary = pod.taskSummary, !summary.deviations.isEmpty {
                deviationsCard(summary.deviations)
            } else {
                emptyWorkSection("No deviations reported", icon: "checkmark.circle")
            }
        case .quality:
            if let signals = quality {
                SessionQualityCard(signals: signals)
            } else {
                emptyWorkSection("No quality signals yet", icon: "gauge.with.dots.needle.67percent")
            }
        }
    }

    private func emptyWorkSection(_ text: String, icon: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 30))
                .foregroundStyle(.tertiary)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 80)
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

    private func taskSummaryCard(_ summary: TaskSummary, includeDeviations: Bool = true) -> some View {
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

            if includeDeviations && !summary.deviations.isEmpty {
                deviationsCard(summary.deviations)
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func deviationsCard(_ deviations: [DeviationItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                Text("Deviations from Plan")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                Text("\(deviations.count)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.orange.opacity(0.1), in: Capsule())
            }

            ForEach(Array(deviations.enumerated()), id: \.offset) { _, deviation in
                deviationCard(deviation)
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

}

// MARK: - Previews

#Preview("Work — validated") {
    WorkTab(pod: MockData.validated)
        .frame(width: 550, height: 600)
}

#Preview("Work — running") {
    WorkTab(pod: MockData.running)
        .frame(width: 550, height: 400)
}
