import SwiftUI

struct ReviewCouncilView: View {
  let council: ReviewCouncil
  let dismissedIds: Set<String>
  let dismissableIds: Set<String>
  let onDismiss: (ReviewCouncil.Finding) -> Void
  @State private var filter: ReviewCouncil.Filter = .open
  private let axisNames = ["contract_completeness": "Contract", "security_authority": "Security", "lifecycle_reliability": "Reliability", "persistence_reproducibility": "Persistence", "tests_integration": "Tests"]
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      summary
      if let overflow = council.overflow { Label("First gate retained \(overflow.retainedFindingCount) of \(overflow.reportedCount) findings. Review is fail-closed.", systemImage: "exclamationmark.octagon.fill").font(.caption.weight(.semibold)).foregroundStyle(.red).padding(10).background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel("First gate overflow; review is fail-closed") }
      Picker("Finding lifecycle", selection: $filter) { Text("Open \(count(.open))").tag(ReviewCouncil.Filter.open); Text("Fixed \(count(.fixed))").tag(ReviewCouncil.Filter.fixed); Text("Regressed \(count(.regressed))").tag(ReviewCouncil.Filter.regressed); Text("Rejected \(count(.rejected))").tag(ReviewCouncil.Filter.rejected); Text("All \(count(.all))").tag(ReviewCouncil.Filter.all) }.pickerStyle(.segmented)
      if filter == .rejected {
        provenanceDecisions
      } else {
        findings
        if filter == .all, !council.rejected.isEmpty { provenanceDecisions }
      }
      provenance
    }
  }
  private var summary: some View { VStack(alignment: .leading, spacing: 10) {
    HStack { Label("Review Council", systemImage: "person.3.fill").font(.headline); Spacer(); Text(synthesisLabel).font(.caption.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 3).background(.blue.opacity(0.12), in: Capsule()) }
    Text("\(council.axes.filter { $0.status == "completed" }.count) / 5 axes complete · \(council.activeCount) active findings · \(duration(council.durationMs))\(cost)").font(.caption).foregroundStyle(.secondary)
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 8)], spacing: 8) { ForEach(council.axes, id: \.axis) { axis in VStack(alignment: .leading, spacing: 3) { Label(axisNames[axis.axis] ?? axis.axis, systemImage: axis.status == "unavailable" ? "wifi.exclamationmark" : "checkmark.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(axis.status == "unavailable" ? .orange : .green); Text(axis.status == "unavailable" ? (axis.error ?? "Infrastructure unavailable") : "Completed · \(axis.attempts) attempt\(axis.attempts == 1 ? "" : "s") · \(council.findings.filter { $0.axis == axis.axis }.count) findings").font(.caption2).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading).padding(8).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 7)) } }
  }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10)) }
  private var findings: some View { VStack(alignment: .leading, spacing: 8) { ForEach(Array(council.groups(filter: filter).enumerated()), id: \.offset) { _, group in Text(group.axis.flatMap { axisNames[$0] } ?? "Initial Review").font(.caption.weight(.semibold)).foregroundStyle(.secondary); ForEach(group.findings) { card($0) } } } }
  private func card(_ finding: ReviewCouncil.Finding) -> some View { let dismissed = dismissedIds.contains(finding.id); return VStack(alignment: .leading, spacing: 7) { HStack { if let severity = finding.severity { badge(severity, color: severity == "CRITICAL" || severity == "HIGH" ? .red : .orange) }; badge(finding.lifecycle == "new" ? "New" : finding.lifecycle.capitalized, color: finding.lifecycle == "regressed" ? .red : .secondary); Spacer(); if dismissed { Text("Dismissed").font(.caption2) } else if dismissableIds.contains(finding.id), council.overflow == nil { Button("Dismiss") { onDismiss(finding) }.controlSize(.small) } }; Text(finding.claim).font(.callout.weight(.semibold)).strikethrough(dismissed).fixedSize(horizontal: false, vertical: true); if let path = finding.path { Text("\(path)\(finding.line.map { ":\($0)" } ?? "")\(finding.symbol.map { " · \($0)" } ?? "")").font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled) }; if finding.evidence != nil || finding.remediation != nil || finding.closureEvidence != nil { DisclosureGroup("Evidence & repair") { if let evidence = finding.evidence { Text(evidence).textSelection(.enabled) }; if let repair = finding.remediation { Text("Recommended repair: \(repair)").textSelection(.enabled) }; if let closure = finding.closureEvidence { Text("Closure evidence: \(closure)").textSelection(.enabled) } }.font(.caption) } }.padding(10).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(finding.lifecycle == "regressed" ? .red : .gray.opacity(0.2))) }
  private var provenanceDecisions: some View { DisclosureGroup("Synthesis decisions") { ForEach(Array(council.rejected.enumerated()), id: \.offset) { _, item in Text("Rejected \(item.sourceIds.joined(separator: ", ")) — \(item.reason)").font(.caption).textSelection(.enabled) }; ForEach(Array(council.merged.enumerated()), id: \.offset) { _, item in Text("Merged \(item.sourceIds.joined(separator: ", ")) → \(item.finding.id)").font(.caption).textSelection(.enabled) } } }
  private var provenance: some View { DisclosureGroup("Provenance") { VStack(alignment: .leading, spacing: 3) { Text("Packet \(council.id) · diff \(String(council.diffHash.prefix(12))) · HEAD \(council.reviewedHead)"); Text("\(council.model) · schema \(council.schemaVersion) · prompt \(council.promptVersion) · \(council.synthesis)"); Text("Accepted \(council.acceptedCount) · rejected \(council.rejected.count) · merged \(council.merged.count) · \(duration(council.durationMs))"); if let usage = council.tokenUsage { Text("Tokens: \(usage.inputTokens) in / \(usage.outputTokens) out\(usage.costUsd.map { String(format: " · $%.4f", $0) } ?? "")") }; if let repair = council.repairDelta { Text("Repair delta: \(repair.status), \(repair.fromHead) → \(repair.toHead)\(repair.diffHash.map { " · \($0)" } ?? "")\(repair.reason.map { " — \($0)" } ?? "")") }; if let closure = council.closureVerification { Text("Closure verification: \(closure.status)\(closure.reason.map { " — \($0)" } ?? "")") } }.font(.system(.caption2, design: .monospaced)).textSelection(.enabled) } }
  private func count(_ state: ReviewCouncil.Filter) -> Int { council.lifecycleCounts[state] ?? 0 }; private func badge(_ text: String, color: Color) -> some View { Text(text).font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(color).padding(.horizontal, 5).padding(.vertical, 2).background(color.opacity(0.12), in: Capsule()) }; private func duration(_ ms: Int) -> String { String(format: "%.1fs", Double(ms) / 1000) }; private var cost: String { council.tokenUsage?.costUsd.map { String(format: " · $%.2f", $0) } ?? "" }
  private var synthesisLabel: String {
    switch council.synthesis {
    case "model": return "Model synthesis"
    case "deterministic-fallback": return "Deterministic fallback"
    default: return "Synthesis unavailable"
    }
  }
}
