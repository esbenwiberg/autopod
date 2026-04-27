import AutopodClient
import SwiftUI

/// Compact card surfacing per-pod behavioural telemetry — Read/Edit ratio,
/// blind edits, interrupts, churn, tells, PR fixes, smoke tests, browser checks,
/// cost. Single source of truth for "how is this agent doing?" across `SummaryTab`
/// and the Series-tab slide-in panel.
public struct SessionQualityCard: View {
    public let signals: PodQualitySignals

    public init(signals: PodQualitySignals) {
        self.signals = signals
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle()
                    .fill(qualityColor(signals.grade))
                    .frame(width: 10, height: 10)
                Text("Session Quality")
                    .font(.system(.subheadline).weight(.semibold))
                Spacer()
                if let score = signals.score {
                    Text("\(score)/100")
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .foregroundStyle(qualityColor(signals.grade))
                }
                Text(signals.grade.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 110), spacing: 8)],
                spacing: 8
            ) {
                let readEdit = signals.readEditTile
                StatTile(icon: "doc.text.magnifyingglass", label: "Read / Edit",
                         value: readEdit.value, health: readEdit.health, hint: readEdit.hint,
                         description: "Ratio of Read calls to Edit/Write/MultiEdit calls. ≥1.5 = green, ≥0.8 = yellow, <0.8 = red. Agents that read before they edit tend to make more accurate, context-aware changes.")
                let blind = signals.blindEditsTile
                StatTile(icon: "eye.slash", label: "Blind Edits",
                         value: blind.value, health: blind.health, hint: blind.hint,
                         description: "Files modified without a prior Read call this session. Editing without reading first often leads to incorrect changes or missed context. 0 = green, ≤2 = yellow, >2 = red.")
                let interrupts = signals.interruptsTile
                StatTile(icon: "hand.raised", label: "Interrupts",
                         value: interrupts.value, health: interrupts.health, hint: interrupts.hint,
                         description: "Human-required escalations: ask_human, report_blocker, request_credential, action_approval, or validation_override. Counts +1 if the pod was killed early. 0 = green, ≤2 = yellow, >2 = red.")
                let cost = signals.costTile
                StatTile(icon: "dollarsign.circle", label: "Cost",
                         value: cost.value, health: cost.health, hint: cost.hint,
                         description: "Total API spend for this pod in USD, based on input and output token counts at current model pricing.")
                let churn = signals.churnTile
                StatTile(icon: "arrow.triangle.2.circlepath", label: "Churn",
                         value: churn.value, health: churn.health, hint: churn.hint,
                         description: "Files modified 3+ times in one session. High churn suggests the agent is struggling with a problem or repeatedly reverting its own work. ≤2 = green, ≤5 = yellow, >5 = red.")
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
}
