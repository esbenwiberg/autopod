import AutopodClient
import MarkdownUI
import SwiftUI

/// Work tab — task, plan, task summary, deviations, quality signals, and cost.
struct WorkTab: View {
    let pod: Pod
    var actions: PodActions = .preview
    /// Optional closures for fetching server-derived cards. When nil
    /// (previews, tests without daemon), the cards are simply hidden.
    var loadQuality: ((String) async throws -> PodQualitySignals)? = nil
    var loadCost: ((String) async throws -> PodCostBreakdownResponse)? = nil

    @State private var quality: PodQualitySignals? = nil
    @State private var cost: PodCostBreakdownResponse? = nil
    @State private var selectedSection: WorkSection = .task
    @State private var factWaiverPopoverFactId: String? = nil
    @State private var factWaiverReason: String = ""
    @State private var approvingFactWaiverIds: Set<String> = []

    private enum WorkSection: String, CaseIterable {
        case task, plan, summary, deviations, quality, cost

        var label: String {
            switch self {
            case .task: "Task"
            case .plan: "Plan"
            case .summary: "Summary"
            case .deviations: "Deviations"
            case .quality: "Quality"
            case .cost: "Cost"
            }
        }

        var icon: String {
            switch self {
            case .task: "text.quote"
            case .plan: "list.bullet.clipboard"
            case .summary: "doc.text.below.ecg"
            case .deviations: "exclamationmark.triangle"
            case .quality: "gauge.with.dots.needle.67percent"
            case .cost: "dollarsign.circle"
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
            await fetchCost()
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

    private var deviationCount: Int {
        pod.taskSummary?.deviationCount ?? 0
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
                        if section == .deviations, deviationCount > 0 {
                            Text("\(deviationCount)")
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
                planCard(plan, phase: pod.phase)
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
            if let summary = pod.taskSummary, summary.deviationCount > 0 {
                deviationsContent(summary)
            } else {
                emptyWorkSection("No deviations reported", icon: "checkmark.circle")
            }
        case .quality:
            if let signals = quality {
                SessionQualityCard(signals: signals)
            } else {
                emptyWorkSection("No quality signals yet", icon: "gauge.with.dots.needle.67percent")
            }
        case .cost:
            if let cost {
                SessionCostCard(breakdown: cost)
            } else {
                emptyWorkSection("No cost data yet", icon: "dollarsign.circle")
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

    private func fetchCost() async {
        guard let loadCost else { return }
        do {
            cost = try await loadCost(pod.id)
        } catch {
            cost = nil
        }
    }

    // MARK: - Prompt

    private var promptCard: some View {
        TaskStructuredView(markdown: pod.task)
    }

    // MARK: - Plan

    private enum PlanStepState {
        case completed
        case current
        case upcoming
        case neutral

        var foreground: Color {
            switch self {
            case .completed: .green
            case .current: .accentColor
            case .upcoming, .neutral: .secondary
            }
        }

        var fill: Color {
            switch self {
            case .completed: .green.opacity(0.16)
            case .current: .accentColor.opacity(0.16)
            case .upcoming, .neutral: Color(nsColor: .separatorColor).opacity(0.18)
            }
        }
    }

    private func planCard(_ plan: SessionPlan, phase: PhaseProgress?) -> some View {
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

            if let phase {
                AgentPhaseProgressView(phase: phase, variant: .detailed, showChrome: false)
                Divider()
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
                        planStepRow(
                            index: index,
                            step: step,
                            state: planStepState(index: index, plan: plan, phase: phase)
                        )
                    }
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func planStepState(index: Int, plan: SessionPlan, phase: PhaseProgress?) -> PlanStepState {
        guard let phase, phase.total == plan.steps.count else {
            return .neutral
        }

        let stepNumber = index + 1
        let current = min(max(phase.current, 1), max(phase.total, 1))
        if stepNumber < current { return .completed }
        if stepNumber == current { return .current }
        return .upcoming
    }

    private func planStepRow(index: Int, step: String, state: PlanStepState) -> some View {
        HStack(alignment: .top, spacing: 10) {
            planStepMarker(index: index, state: state)
                .padding(.top, 1)

            Markdown(step)
                .markdownTheme(.autopod)
                .font(.callout)
                .foregroundStyle(state == .current ? .primary : .secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, state == .current ? 8 : 0)
        .padding(.vertical, state == .current ? 6 : 0)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(state == .current ? Color.accentColor.opacity(0.08) : .clear)
        )
    }

    private func planStepMarker(index: Int, state: PlanStepState) -> some View {
        ZStack {
            Circle()
                .fill(state.fill)
                .frame(width: 22, height: 22)
                .overlay(
                    Circle()
                        .stroke(
                            state.foreground.opacity(state == .upcoming ? 0.18 : 0.28),
                            lineWidth: 1
                        )
                )

            if state == .completed {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(state.foreground)
            } else {
                Text("\(index + 1)")
                    .font(.system(.caption2, design: .rounded).weight(.semibold))
                    .foregroundStyle(state.foreground)
            }
        }
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
                if summary.deviationCount > 0 {
                    HStack(spacing: 3) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 9))
                        Text("\(summary.deviationCount) deviation\(summary.deviationCount == 1 ? "" : "s")")
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

            if includeDeviations && summary.deviationCount > 0 {
                deviationsContent(summary)
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func deviationsContent(_ summary: TaskSummary) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if !summary.deviations.isEmpty {
                deviationsCard(summary.deviations)
            }
            if !summary.factDeviations.isEmpty {
                factDeviationsCard(summary.factDeviations)
            }
        }
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

    private func factDeviationsCard(_ deviations: [FactDeviationItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal")
                    .foregroundStyle(.orange)
                Text("Required Fact Deviations")
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
                factDeviationCard(deviation)
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

    private func factDeviationCanApprove(_ deviation: FactDeviationItem) -> Bool {
        guard deviation.action == "waive", deviation.decision == nil else { return false }
        return true
    }

    private func factDeviationWaiverButton(_ deviation: FactDeviationItem) -> some View {
        let factId = deviation.factId
        let isApproving = approvingFactWaiverIds.contains(factId)
        return Button {
            factWaiverReason = deviation.reason
            factWaiverPopoverFactId = factId
        } label: {
            if isApproving {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text("Approving...").lineLimit(1)
                }
            } else {
                Label("Approve Waiver", systemImage: "checkmark.seal.fill").lineLimit(1)
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .tint(.green)
        .disabled(isApproving)
        .popover(isPresented: Binding(
            get: { factWaiverPopoverFactId == factId },
            set: { if !$0 { factWaiverPopoverFactId = nil } }
        )) {
            factDeviationWaiverPopover(deviation)
        }
    }

    @ViewBuilder
    private func factDeviationWaiverPopover(_ deviation: FactDeviationItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Approve Fact Waiver").font(.headline)
            Text("Mark this required fact as waived and re-run validation so later gates can continue.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(deviation.whyImpossible)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("Reason", text: $factWaiverReason).textFieldStyle(.roundedBorder)
            HStack {
                Button("Cancel") { factWaiverPopoverFactId = nil }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                Spacer()
                Button("Approve Waiver") {
                    let fid = deviation.factId
                    let reason = factWaiverReason.isEmpty ? nil : factWaiverReason
                    factWaiverPopoverFactId = nil
                    factWaiverReason = ""
                    approvingFactWaiverIds.insert(fid)
                    Task {
                        await actions.approveFactWaiver(pod.id, fid, reason)
                        approvingFactWaiverIds.remove(fid)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(.green)
            }
        }
        .padding(16)
        .frame(width: 320)
    }

    private func factDeviationCard(_ deviation: FactDeviationItem) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(Color.orange.opacity(0.65))
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(deviation.factId)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                    Text(deviation.action)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.orange.opacity(0.1), in: Capsule())
                    if let decision = deviation.decision {
                        Text(decision)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    if factDeviationCanApprove(deviation) {
                        factDeviationWaiverButton(deviation)
                    }
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("REASON")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .tracking(0.4)
                    Text(deviation.reason)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("WHY IMPOSSIBLE")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .tracking(0.4)
                    Text(deviation.whyImpossible)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }

                if let replacement = deviation.replacement {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("REPLACEMENT")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .tracking(0.4)
                        Text(replacement.artifactPath)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        Text(replacement.command)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
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

#Preview("Work — aligned plan progress") {
    WorkTab(
        pod: Pod(
            status: .running,
            branch: "feature/progress",
            profileName: "desktop",
            task: "Make pod progress visible in the desktop detail views",
            model: "sonnet",
            startedAt: Date().addingTimeInterval(-12 * 60),
            plan: SessionPlan(
                summary: "Add shared progress presentation for Overview and Work plan views",
                steps: [
                    "Create a reusable compact phase progress component",
                    "Use the compact component in Overview",
                    "Show detailed progress in the Plan view",
                    "Verify the desktop package builds",
                ]
            ),
            phase: PhaseProgress(current: 3, total: 4, description: "Show detailed progress in the Plan view")
        )
    )
    .frame(width: 650, height: 520)
}
