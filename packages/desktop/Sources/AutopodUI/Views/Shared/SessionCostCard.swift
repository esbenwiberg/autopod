import AutopodClient
import SwiftUI

public struct SessionCostCard: View {
    public let breakdown: PodCostBreakdownResponse

    public init(breakdown: PodCostBreakdownResponse) {
        self.breakdown = breakdown
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "dollarsign.circle")
                    .foregroundStyle(.green)
                Text("Session Cost Subtotal")
                    .font(.system(.headline).weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text(formatCost(breakdown.totalCostUsd))
                    .font(.system(size: 18, weight: .semibold, design: .monospaced))
                    .monospacedDigit()
            }

            CostEvidenceView(evidence: breakdown.costEvidence)

            if let task = breakdown.taskExecution {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Task accounting").font(.headline)
                    Text(task.taskId).font(.caption).textSelection(.enabled)
                    Text("\(task.podCount) pods · \(task.agentRunCount) recorded agent runs · \(task.providerAttemptCount) provider attempts · \(task.validationExecutionCount) validations")
                    if let delivery = task.delivery {
                        Text("\(delivery.receiptCount) PR receipts · \(delivery.unresolvedCount) unresolved of \(delivery.intentCount) intents")
                        Text("Durable ledger only; historical PR URLs excluded.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("PR receipts unavailable").font(.caption).foregroundStyle(.secondary)
                    }
                    if let disposition = task.delivery?.disposition {
                        Text("Last recorded PR status: \(disposition.openCount) open · \(disposition.mergedCount) merged · \(disposition.closedCount) closed · \(disposition.unavailableCount) unavailable")
                    } else {
                        Text("PR disposition observations unavailable.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let merge = task.merge {
                        Text("Source-bound merges: \(merge.mergedPrCount) merged PRs · \(merge.requestCount) recorded requests · \(merge.unresolvedPrCount) unresolved of \(merge.prCount) PRs")
                        Text("\(merge.mergedWithoutRecordedRequestCount) merged PRs observed with no recorded request; merge actor is not inferred.")
                        Text("Last recorded closed PRs: \(merge.closedPrCount.map(String.init) ?? "unavailable")")
                        Text("Source-bound journal only; historical PR URLs excluded.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Source-bound merge evidence unavailable.").font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Current provider status unverified.").font(.caption).foregroundStyle(.secondary)
                    Text("Stored task cost subtotal: \(formatCost(task.recordedCostUsd)) · \(task.telemetry) telemetry")
                    CostEvidenceView(evidence: task.costEvidence)
                    Text("Task tokens: \(task.recordedInputTokens + task.recordedOutputTokens) / \(task.tokenBudget.map(String.init) ?? "no configured limit")")
                    Text(task.budgetCheck?.reason ?? "Task budget admission evidence unavailable.")
                    ForEach(task.diagnostics, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                }
            } else {
                Text("Task accounting unavailable").font(.caption).foregroundStyle(.secondary)
            }

            costBar

            VStack(spacing: 0) {
                ForEach(breakdown.segments.indices, id: \.self) { index in
                    let segment = breakdown.segments[index]
                    costRow(segment)
                    if index < breakdown.segments.count - 1 {
                        Divider().opacity(0.45)
                    }
                }
            }

            HStack(spacing: 14) {
                tokenPill(
                    icon: "arrow.up.circle",
                    label: "Tokens In",
                    value: formatTokenCount(breakdown.inputTokens)
                )
                tokenPill(
                    icon: "arrow.down.circle",
                    label: "Tokens Out",
                    value: formatTokenCount(breakdown.outputTokens)
                )
                Spacer(minLength: 0)
            }

            if let model = breakdown.model, !model.isEmpty {
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

    @ViewBuilder
    private var costBar: some View {
        let segments = breakdown.segments.filter { $0.costUsd > 0 }
        let total = segments.reduce(0.0) { $0 + $1.costUsd }

        if total > 0 {
            GeometryReader { geo in
                HStack(spacing: 0) {
                    ForEach(segments) { segment in
                        Rectangle()
                            .fill(segmentColor(segment.bucket))
                            .frame(
                                width: max(CGFloat(segment.costUsd / total) * geo.size.width, 1)
                            )
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .frame(height: 22)
        } else {
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.secondary.opacity(0.12))
                .frame(height: 22)
        }
    }

    private func costRow(_ segment: PodCostSegment) -> some View {
        let isZero = segment.costUsd == 0

        return HStack(spacing: 10) {
            Circle()
                .fill(isZero ? Color.secondary.opacity(0.25) : segmentColor(segment.bucket))
                .frame(width: 9, height: 9)

            VStack(alignment: .leading, spacing: 2) {
                Text(segment.label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isZero ? .secondary : .primary)
                Text(tokenSummary(segment))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 12)

            VStack(alignment: .trailing, spacing: 2) {
                Text(segment.attribution == "unavailable" ? "Unavailable" : formatCost(segment.costUsd))
                if segment.attribution == "unavailable", let stored = segment.storedCostUsd {
                    Text("Stored: \(formatCost(stored))").font(.caption2)
                }
            }
                .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                .foregroundStyle(isZero ? .secondary : .primary)
                .monospacedDigit()
        }
        .padding(.vertical, 9)
        .help(
            segment.sourcePhases.isEmpty
                ? segment.label
                : segment.sourcePhases.joined(separator: ", ")
        )
    }

    private func tokenPill(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.primary)
                .monospacedDigit()
        }
        .lineLimit(1)
    }

    private func tokenSummary(_ segment: PodCostSegment) -> String {
        let total = segment.inputTokens + segment.outputTokens
        guard total > 0 else { return "No attributed tokens" }
        return "\(formatTokenCount(segment.inputTokens)) in / \(formatTokenCount(segment.outputTokens)) out"
    }

    private func segmentColor(_ bucket: String) -> Color {
        switch bucket {
        case "work": return .blue
        case "rework": return .teal
        case "validation": return .orange
        case "advisory": return .purple
        case "unattributed": return .gray
        default: return .secondary
        }
    }

    private func formatCost(_ value: Double) -> String {
        if value > 0 && value < 0.01 { return "$<0.01" }
        return String(format: "$%.2f", value)
    }

    private func formatTokenCount(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return "\(count / 1_000)K" }
        return "\(count)"
    }
}

#if DEBUG
#Preview("Session Cost") {
    SessionCostCard(
        breakdown: PodCostBreakdownResponse(
            podId: "pod-123",
            model: "gpt-5",
            totalCostUsd: 10,
            inputTokens: 5_000_000,
            outputTokens: 250_000,
            segments: [
                PodCostSegment(
                    bucket: "work",
                    label: "Work",
                    costUsd: 2.5,
                    inputTokens: 2_000_000,
                    outputTokens: 0,
                    sourcePhases: ["agent_initial"]
                ),
                PodCostSegment(
                    bucket: "rework",
                    label: "Rework",
                    costUsd: 1.25,
                    inputTokens: 1_000_000,
                    outputTokens: 0,
                    sourcePhases: ["agent_rework_1"]
                ),
                PodCostSegment(
                    bucket: "validation",
                    label: "Validation",
                    costUsd: 1.25,
                    inputTokens: 1_000_000,
                    outputTokens: 0,
                    sourcePhases: ["review"]
                ),
                PodCostSegment(
                    bucket: "advisory",
                    label: "Advisory",
                    costUsd: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    sourcePhases: []
                ),
                PodCostSegment(
                    bucket: "unattributed",
                    label: "Unattributed",
                    costUsd: 5,
                    inputTokens: 0,
                    outputTokens: 0,
                    sourcePhases: ["agent_legacy"]
                ),
            ]
        )
    )
    .frame(width: 520)
    .padding()
}
#endif
