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
                // Session quality — behavioural telemetry (read:edit, blind edits, interrupts)
                if let signals = quality {
                    qualityCard(signals)
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

                // Pod prompt
                promptSection
            }
            .padding(20)
        }
        .task(id: pod.id) {
            await fetchQuality()
        }
    }

    // MARK: - Session quality

    private func fetchQuality() async {
        guard let loadQuality else { return }
        do {
            quality = try await loadQuality(pod.id)
        } catch {
            // Non-fatal: pod may have been killed early, daemon may not have
            // the route wired (503), etc. Leave the card hidden.
            quality = nil
        }
    }

    private func qualityCard(_ s: PodQualitySignals) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle()
                    .fill(qualityColor(s.grade))
                    .frame(width: 10, height: 10)
                Text("Session Quality")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                if let score = s.score {
                    Text("\(score)/100")
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .foregroundStyle(qualityColor(s.grade))
                }
                Text(s.grade.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 110), spacing: 8)],
                spacing: 8
            ) {
                let readEdit = s.readEditTile
                StatTile(icon: "doc.text.magnifyingglass", label: "Read / Edit",
                         value: readEdit.value, health: readEdit.health, hint: readEdit.hint)
                let blind = s.blindEditsTile
                StatTile(icon: "eye.slash", label: "Blind Edits",
                         value: blind.value, health: blind.health, hint: blind.hint)
                let interrupts = s.interruptsTile
                StatTile(icon: "hand.raised", label: "Interrupts",
                         value: interrupts.value, health: interrupts.health, hint: interrupts.hint)
                let cost = s.costTile
                StatTile(icon: "dollarsign.circle", label: "Cost",
                         value: cost.value, health: cost.health, hint: cost.hint)
                let churn = s.churnTile
                StatTile(icon: "arrow.triangle.2.circlepath", label: "Churn",
                         value: churn.value, health: churn.health, hint: churn.hint)
                let tells = s.tellsTile
                StatTile(icon: "quote.bubble", label: "Tells",
                         value: tells.value, health: tells.health, hint: tells.hint)
                let prFixes = s.prFixesTile
                StatTile(icon: "wrench.and.screwdriver", label: "PR Fixes",
                         value: prFixes.value, health: prFixes.health, hint: prFixes.hint)
                let smoke = s.smokeTestsTile
                StatTile(icon: "checkmark.seal", label: "Smoke Tests",
                         value: smoke.value, health: smoke.health, hint: smoke.hint)
                let browser = s.browserChecksTile
                StatTile(icon: "globe", label: "Browser Checks",
                         value: browser.value, health: browser.health, hint: browser.hint)
            }

            if let model = s.model, !model.isEmpty {
                Text("Model: \(model)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func qualityColor(_ grade: String) -> Color {
        switch grade.lowercased() {
        case "green": return .green
        case "yellow": return .yellow
        case "red": return .red
        default: return .gray
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
