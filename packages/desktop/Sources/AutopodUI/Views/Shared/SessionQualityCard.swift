import AutopodClient
import SwiftUI

/// Compact card surfacing per-pod process telemetry — Read/Edit ratio,
/// blind edits, interrupts, churn, tells, PR fixes, smoke tests, browser checks,
/// cost. This describes observable process health, not end-result correctness, across `SummaryTab`
/// and the Series-tab slide-in panel.
public struct SessionQualityCard: View {
    public let signals: PodQualitySignals

    public init(signals: PodQualitySignals) {
        self.signals = signals
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 6) {
                Circle()
                    .fill(signals.inspectionAvailability == .available ? qualityColor(signals.grade) : .gray)
                    .frame(width: 10, height: 10)
                Text("Session Process Health")
                    .font(.system(.headline).weight(.semibold))
                    .lineLimit(1)
                Spacer()
                if signals.inspectionAvailability == .available,
                   let score = signals.score {
                    qualityScoreBadge(score)
                } else if signals.inspectionAvailability == .unavailable {
                    Text("Unavailable")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .help(signals.inspectionUnavailableReason ?? "Inspection telemetry unavailable")
                }
                if signals.inspectionAvailability == .available {
                    Text(signals.grade.capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Text("The score uses inspection discipline, blind-modification rate, tells, human interruptions, and churn. Validation and PR fixes are shown only as outcome context.")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 156), spacing: 12)],
                alignment: .leading,
                spacing: 12
            ) {
                let readEdit = signals.readEditTile
                StatTile(icon: "doc.text.magnifyingglass", label: "Read / Edit",
                         value: readEdit.value, health: readEdit.health, hint: readEdit.hint,
                         description: "Ratio of recognized repository inspections to file mutations. ≥3 = green, ≥1 = yellow, <1 = red. Unresolved inspection-looking shell activity makes this signal unavailable rather than falsely low.")
                let blind = signals.blindEditsTile
                StatTile(icon: "eye.slash", label: "Blind Edits",
                         value: blind.value, health: blind.health, hint: blind.hint,
                         description: "Existing files modified without a prior recognized inspection. Health uses the rate over distinct modified existing files so larger tasks are not penalized by absolute count.")
                let interrupts = signals.interruptsTile
                StatTile(icon: "hand.raised", label: "Interrupts",
                         value: interrupts.value, health: interrupts.health, hint: interrupts.hint,
                         description: "Human-attention escalations: ask_human, report_blocker, action_approval, or validation_override. Autonomous credential vending and killed state are excluded. 0 = green, ≤2 = yellow, >2 = red.")
                let inputTokens = signals.inputTokensTile
                StatTile(icon: "arrow.up.circle", label: "Tokens In",
                         value: inputTokens.value, health: inputTokens.health, hint: inputTokens.hint,
                         description: "Input tokens consumed by this pod across agent runs.")
                let outputTokens = signals.outputTokensTile
                StatTile(icon: "arrow.down.circle", label: "Tokens Out",
                         value: outputTokens.value, health: outputTokens.health, hint: outputTokens.hint,
                         description: "Output tokens consumed by this pod across agent runs.")
                let cost = signals.costTile
                StatTile(icon: "dollarsign.circle", label: "Cost",
                         value: cost.value, health: cost.health, hint: cost.hint,
                         description: "Total API spend for this pod in USD, based on input and output token counts at current model pricing.")
                let churn = signals.churnTile
                StatTile(icon: "arrow.triangle.2.circlepath", label: "Churn",
                         value: churn.value, health: churn.health, hint: churn.hint,
                         description: "Existing files modified 3+ times in one session. Health uses the churn rate over distinct modified files, avoiding an absolute task-size penalty.")
                let tells = signals.tellsTile
                StatTile(icon: "quote.bubble", label: "Tells",
                         value: tells.value, health: tells.health, hint: tells.hint,
                         description: "Hedging phrases detected in agent output — e.g. \"I apologize\", \"I'm not sure\", \"no clear path forward\". These signal confusion or low confidence. ≤1 = green, ≤4 = yellow, >4 = red.")
                let prFixes = signals.prFixesTile
                StatTile(icon: "wrench.and.screwdriver", label: "PR Fixes",
                         value: prFixes.value, health: prFixes.health, hint: prFixes.hint,
                         description: "Fix-pods spawned in response to CI failures or review comments on the submitted PR. More fix attempts = more rework after submission. 0 = green, ≤2 = yellow, >2 = red.")
                let smoke = signals.smokeTestsTile
                StatTile(icon: "checkmark.seal", label: "Smoke Tests",
                         value: smoke.value, health: smoke.health, hint: smoke.hint,
                         description: "Daemon-run validation pipeline: build check, health check, smoke tests, and AI code review. Separate from the agent's own browser validation calls — see Browser Checks.")
                let browser = signals.browserChecksTile
                StatTile(icon: "globe", label: "Browser Checks",
                         value: browser.value, health: browser.health, hint: browser.hint,
                         description: "validate_in_browser calls made by the agent itself during the session. Shows how many Playwright checks ran and how many passed.")
            }

            if let model = signals.model, !model.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "cpu")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                    Text("Model:")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                    Text(model)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color(nsColor: .separatorColor).opacity(0.18), lineWidth: 1)
        )
    }

    private func qualityColor(_ grade: String) -> Color {
        switch grade.lowercased() {
        case "green": return .green
        case "yellow": return .yellow
        case "red": return .red
        default: return .gray
        }
    }

    private func qualityScoreBadge(_ score: Int) -> some View {
        let color = qualityColor(signals.grade)

        return HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text("\(score)")
                .font(.system(size: 15, weight: .bold, design: .monospaced))
                .foregroundStyle(color)
            Text("/100")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(color.opacity(0.78))
                .baselineOffset(1)
        }
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(minWidth: 62)
        .background(
            Capsule()
                .fill(color.opacity(0.16))
        )
        .overlay(
            Capsule()
                .stroke(color.opacity(0.42), lineWidth: 1)
        )
        .help("Process health \(score)/100")
    }
}
