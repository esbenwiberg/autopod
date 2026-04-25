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
                         value: readEdit.value, health: readEdit.health, hint: readEdit.hint)
                let blind = signals.blindEditsTile
                StatTile(icon: "eye.slash", label: "Blind Edits",
                         value: blind.value, health: blind.health, hint: blind.hint)
                let interrupts = signals.interruptsTile
                StatTile(icon: "hand.raised", label: "Interrupts",
                         value: interrupts.value, health: interrupts.health, hint: interrupts.hint)
                let cost = signals.costTile
                StatTile(icon: "dollarsign.circle", label: "Cost",
                         value: cost.value, health: cost.health, hint: cost.hint)
                let churn = signals.churnTile
                StatTile(icon: "arrow.triangle.2.circlepath", label: "Churn",
                         value: churn.value, health: churn.health, hint: churn.hint)
                let tells = signals.tellsTile
                StatTile(icon: "quote.bubble", label: "Tells",
                         value: tells.value, health: tells.health, hint: tells.hint)
                let prFixes = signals.prFixesTile
                StatTile(icon: "wrench.and.screwdriver", label: "PR Fixes",
                         value: prFixes.value, health: prFixes.health, hint: prFixes.hint)
                let smoke = signals.smokeTestsTile
                StatTile(icon: "checkmark.seal", label: "Smoke Tests",
                         value: smoke.value, health: smoke.health, hint: smoke.hint)
                let browser = signals.browserChecksTile
                StatTile(icon: "globe", label: "Browser Checks",
                         value: browser.value, health: browser.health, hint: browser.hint)
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
