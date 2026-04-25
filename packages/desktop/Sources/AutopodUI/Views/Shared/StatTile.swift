import AutopodClient
import SwiftUI

public enum StatHealth {
    case good, warn, bad, neutral

    fileprivate var color: Color {
        switch self {
        case .good: return .green
        case .warn: return .yellow
        case .bad: return .red
        case .neutral: return .secondary
        }
    }
}

/// Compact metric tile: SF Symbol, label, monospaced value, and a thin
/// health-colored accent bar. Used by the Session Quality grid in `SummaryTab`.
public struct StatTile: View {
    public let icon: String
    public let label: String
    public let value: String
    public let health: StatHealth
    public let hint: String

    public init(
        icon: String,
        label: String,
        value: String,
        health: StatHealth,
        hint: String
    ) {
        self.icon = icon
        self.label = label
        self.value = value
        self.health = health
        self.hint = hint
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(iconColor)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Text(value)
                .font(.system(.title3, design: .monospaced).weight(.semibold))
                .foregroundStyle(valueColor)
                .monospacedDigit()
                .lineLimit(1)

            if health != .neutral {
                Rectangle()
                    .fill(health.color)
                    .frame(width: 24, height: 2)
                    .clipShape(Capsule())
            } else {
                // Reserve the same vertical space so neutral tiles align with
                // colored ones in the grid.
                Color.clear.frame(height: 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .help(hint)
    }

    private var iconColor: Color {
        health == .neutral ? .secondary : health.color.opacity(0.8)
    }

    private var valueColor: Color {
        health == .neutral ? .primary : health.color
    }
}

// MARK: - PodQualitySignals → tile inputs

public extension PodQualitySignals {
    var readEditTile: (value: String, health: StatHealth, hint: String) {
        let hint = "\(readCount) Read calls vs \(editCount) Edit/Write/MultiEdit calls. Higher is better."
        if editCount == 0 {
            return ("—", .neutral, hint)
        }
        let value = String(format: "%.1f", readEditRatio)
        let health: StatHealth =
            readEditRatio >= 1.5 ? .good :
            readEditRatio >= 0.8 ? .warn : .bad
        return (value, health, hint)
    }

    var blindEditsTile: (value: String, health: StatHealth, hint: String) {
        let n = editsWithoutPriorRead
        let health: StatHealth = n == 0 ? .good : (n <= 2 ? .warn : .bad)
        return ("\(n)", health, "\(n) files modified without being Read first this session.")
    }

    var interruptsTile: (value: String, health: StatHealth, hint: String) {
        let n = userInterrupts
        let health: StatHealth = n == 0 ? .good : (n <= 2 ? .warn : .bad)
        let hint = "\(n) escalations needing human attention (ask_human, report_blocker, request_credential, action_approval, validation_override) + 1 if pod was killed."
        return ("\(n)", health, hint)
    }

    var costTile: (value: String, health: StatHealth, hint: String) {
        let value = String(format: "$%.2f", tokens.costUsd)
        let hint = "\(tokens.input) input + \(tokens.output) output tokens."
        return (value, .neutral, hint)
    }

    var churnTile: (value: String, health: StatHealth, hint: String) {
        let n = editChurnCount
        let health: StatHealth = n <= 2 ? .good : (n <= 5 ? .warn : .bad)
        return ("\(n)", health, "\(n) files modified 3+ times this session — indicates rework.")
    }

    var tellsTile: (value: String, health: StatHealth, hint: String) {
        let n = tellsCount
        let health: StatHealth = n <= 1 ? .good : (n <= 4 ? .warn : .bad)
        return ("\(n)", health, "\(n) hedging patterns matched (e.g. 'I apologize', 'no clear path forward').")
    }

    var prFixesTile: (value: String, health: StatHealth, hint: String) {
        let n = prFixAttempts
        let health: StatHealth = n == 0 ? .good : (n <= 2 ? .warn : .bad)
        return ("\(n)", health, "\(n) fix-pods spawned for CI failures or review comments.")
    }

    var smokeTestsTile: (value: String, health: StatHealth, hint: String) {
        let hint = "Daemon's smoke / build / health / AI-review pipeline. Does not include the agent's own validate_in_browser calls — see Browser Checks."
        guard let passed = validationPassed else {
            return ("—", .neutral, hint + " No runs yet.")
        }
        return passed ? ("✓", .good, hint) : ("✗", .bad, hint)
    }

    var browserChecksTile: (value: String, health: StatHealth, hint: String) {
        guard let bc = browserChecks else {
            return ("—", .neutral, "Agent did not call validate_in_browser this session.")
        }
        let hint = "\(bc.calls) validate_in_browser run(s). \(bc.passedChecks) of \(bc.totalChecks) checks passed."
        if bc.totalChecks == 0 {
            // Calls happened but every output was malformed JSON — surface as a warning.
            return ("\(bc.calls)", .warn, hint)
        }
        let value = "\(bc.passedChecks)/\(bc.totalChecks)"
        let ratio = Double(bc.passedChecks) / Double(bc.totalChecks)
        let health: StatHealth = ratio >= 1.0 ? .good : (ratio >= 0.8 ? .warn : .bad)
        return (value, health, hint)
    }
}

// MARK: - Preview

#if DEBUG
#Preview("StatTile states") {
    LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 110), spacing: 8)],
        spacing: 8
    ) {
        StatTile(icon: "doc.text.magnifyingglass", label: "Read / Edit",
                 value: "2.4", health: .good, hint: "Healthy")
        StatTile(icon: "eye.slash", label: "Blind Edits",
                 value: "2", health: .warn, hint: "Some")
        StatTile(icon: "hand.raised", label: "Interrupts",
                 value: "5", health: .bad, hint: "Many")
        StatTile(icon: "dollarsign.circle", label: "Cost",
                 value: "$7.62", health: .neutral, hint: "Cost neutral")
        StatTile(icon: "checkmark.seal", label: "Smoke Tests",
                 value: "✓", health: .good, hint: "Passed")
        StatTile(icon: "globe", label: "Browser Checks",
                 value: "14/18", health: .warn, hint: "Mostly passed")
    }
    .padding()
    .frame(width: 560)
}
#endif
