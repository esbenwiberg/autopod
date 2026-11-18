import AppKit
import AutopodClient
import SwiftUI

/// Discovery only. No source selection, retry grant or execution is inferred here.
struct InfrastructureRecoveryHandoff: View {
  let podId: String
  let context: RepairRetainedContext?
  let inspectionError: String?
  var canReviewReplacement = false
  var onReviewReplacement: () -> Void = {}

  static func inspectionCommand(podId: String) -> String {
    // Pod identity is data, never shell syntax. Copying this command only inspects.
    let quoted = "'" + podId.replacingOccurrences(of: "'", with: "'\\''") + "'"
    return "autopod recover-infrastructure \(quoted) --json"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label("Infrastructure recovery required", systemImage: "lifepreserver")
        .font(.headline).accessibilityIdentifier("repair-infrastructure-handoff")
      Text("Work and evidence are retained. This is a recorded lifecycle hold, not a live infrastructure health check. Refreshing, raising the token budget or retrying the worker cannot repair it.")
        .fixedSize(horizontal: false, vertical: true)
      if let inspection = context?.inspection {
        ForEach(Array(inspection.infrastructure.needs.enumerated()), id: \.offset) { _, need in
          VStack(alignment: .leading, spacing: 4) {
            Text([need.owner, need.phase].compactMap { $0 }.joined(separator: " / "))
              .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(need.needs ?? "Inspect the original report for the recorded need.").textSelection(.enabled)
            Text("Report \(need.id)").font(.caption).foregroundStyle(.secondary)
            if need.truncated {
              Text("This report is shortened. Inspect the original report before selecting recovery.")
                .font(.caption).foregroundStyle(.orange)
                .accessibilityIdentifier("repair-infrastructure-report-truncated-\(need.id)")
            }
          }
        }
        if inspection.infrastructure.truncated {
          Text("Some reports were omitted. Inspect the full recorded reports before selecting recovery.")
            .font(.caption).accessibilityIdentifier("repair-infrastructure-reports-truncated")
        }
        Text(inspection.prerequisites.sourcePreservationRecorded && inspection.prerequisites.workerSettlementRecorded
          ? "Source preservation and worker settlement are recorded. Exact source, resource state and the replacement environment still require inspection."
          : "Source preservation or worker settlement is not confirmed here. Keep the original resources; the owning recovery must verify them.")
          .font(.caption).foregroundStyle(.secondary)
      }
      if let inspectionError { Text(inspectionError).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
      Text("Fresh checks without coding").font(.subheadline.weight(.semibold))
      Text("Inspect the existing recovery protocol in your terminal. Select the exact preserved HEAD and a checks-only request after diagnosing the recorded needs. The daemon rechecks source, termination, environment and retry permissions; inspection is not admission.")
        .font(.callout)
      Text(Self.inspectionCommand(podId: podId)).font(.system(.caption, design: .monospaced))
        .textSelection(.enabled).accessibilityIdentifier("repair-infrastructure-command")
      Button("Copy read-only inspection command", systemImage: "doc.on.doc") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(Self.inspectionCommand(podId: podId), forType: .string)
      }.accessibilityIdentifier("repair-infrastructure-copy")
      Text("Save the exact request before applying it. If the outcome is uncertain, observe or reconcile that same request; do not submit a new ID. Fresh checks and independent review must pass, followed by separate human approval. Nothing here starts, resumes, deletes or publishes work.")
        .font(.caption).foregroundStyle(.secondary)
      if canReviewReplacement {
        Divider()
        Button("Review replacement environment and coding repair…", action: onReviewReplacement)
          .accessibilityIdentifier("repair-infrastructure-replacement")
        Text("A separate path for one coding segment, only if its replacement qualifies. Opening it only inspects; it does not start coding or clear this hold.")
          .font(.caption).foregroundStyle(.secondary)
      }
    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
      .background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 7))
  }
}
