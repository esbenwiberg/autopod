import AutopodClient
import SwiftUI

struct ReviewCouncilView: View {
  let council: ReviewCouncil
  let dismissedIds: Set<String>
  let availableFindings: [ValidationFindingResponse]
  let onDismiss: (ReviewCouncil.Finding, ValidationFindingResponse) -> Void
  @State private var filter: ReviewCouncil.Filter = .open
  @State private var fixedExpanded = false
  private let axisNames = ["contract_completeness": "Contract", "security_authority": "Security", "lifecycle_reliability": "Reliability", "persistence_reproducibility": "Persistence", "tests_integration": "Tests"]

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      summary
      if council.isDegraded { degradedBanner }
      if let overflow = council.overflow { Label("First gate retained \(overflow.retainedFindingCount) of \(overflow.reportedCount) findings. Review is fail-closed.", systemImage: "exclamationmark.octagon.fill").font(.caption.weight(.semibold)).foregroundStyle(.red).padding(10).background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel("First gate overflow; review is fail-closed") }
      Picker("Finding lifecycle", selection: $filter) { Text("Open \(count(.open))").tag(ReviewCouncil.Filter.open); Text("Fixed \(count(.fixed))").tag(ReviewCouncil.Filter.fixed); Text("Regressed \(count(.regressed))").tag(ReviewCouncil.Filter.regressed); Text("Rejected \(count(.rejected))").tag(ReviewCouncil.Filter.rejected); Text("All \(count(.all))").tag(ReviewCouncil.Filter.all) }.pickerStyle(.segmented)
      if filter == .rejected { provenanceDecisions }
      else if filter == .all { allFindings }
      else { findingGroups(council.groups(filter: filter)) }
      if filter == .all, !council.rejected.isEmpty { provenanceDecisions }
      provenance
    }
  }

  private var summary: some View { VStack(alignment: .leading, spacing: 10) {
    HStack { Label("Review Council", systemImage: "person.3.fill").font(.headline); Spacer(); Text(synthesisLabel).font(.caption.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 3).background(.blue.opacity(0.12), in: Capsule()) }
    Text("\(council.axes.filter { $0.status == "completed" }.count) / 5 axes complete · \(council.activeCount) needing attention · \(duration(council.durationMs))\(cost)").font(.caption).foregroundStyle(.secondary)
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 8)], spacing: 8) { ForEach(council.axes, id: \.axis) { axis in axisCard(axis) } }
  }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10)) }

  private func axisCard(_ axis: ReviewAxisRunResponse) -> some View { VStack(alignment: .leading, spacing: 3) {
    let failed = axis.status != "completed"
    Label(axisNames[axis.axis] ?? axis.axis, systemImage: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(failed ? .orange : .green)
    Text(failed ? axisFailureCopy(axis) : "Completed").font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    if failed, let detail = axis.failure?.message ?? axis.error { Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(3) }
    Text("\(axis.attempts) attempt\(axis.attempts == 1 ? "" : "s") · \(council.findings.filter { $0.axis == axis.axis }.count) findings").font(.caption2).foregroundStyle(.secondary)
    axisDuration(axis)
  }.frame(maxWidth: .infinity, alignment: .leading).padding(8).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 7)).accessibilityElement(children: .combine).accessibilityLabel("\(axisNames[axis.axis] ?? axis.axis): \(failed ? axisFailureCopy(axis) : "completed")") }

  private var degradedBanner: some View { VStack(alignment: .leading, spacing: 4) {
    Label("Council degraded — first-gate fallback findings are included.", systemImage: "exclamationmark.triangle.fill").font(.caption.weight(.semibold))
    if !council.degradationReasons.isEmpty { Text(council.degradationReasons.map(degradationCopy).joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary) }
  }.padding(10).background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8)).accessibilityElement(children: .combine).accessibilityLabel("Council degraded. First-gate fallback findings are included.") }

  private var allFindings: some View { VStack(alignment: .leading, spacing: 10) {
    let attention = council.findings(filter: .all).filter { $0.lifecycle != "fixed" }
    if !attention.isEmpty { Text("Needs attention (\(attention.count))").font(.headline); findingGroups(council.groups(findings: attention)) }
    let fixed = council.findings(filter: .fixed)
    if !fixed.isEmpty { DisclosureGroup("Fixed in this revision (\(fixed.count))", isExpanded: $fixedExpanded) { findingGroups(council.groups(findings: fixed)) }.accessibilityLabel("Fixed in this revision, \(fixed.count) findings") }
  } }

  @ViewBuilder private func findingGroups(_ groups: [ReviewCouncil.Group]) -> some View { ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
    Text(group.axis.flatMap { axisNames[$0] } ?? (group.findings.first?.isFirstGateFallback == true ? "First-gate fallback" : "Initial Review")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
    ForEach(group.findings) { card($0) }
  } }

  private func card(_ finding: ReviewCouncil.Finding) -> some View { let fixed = finding.lifecycle == "fixed"; let overrideFinding = fixed ? nil : council.canonicalDismissFinding(for: finding, in: availableFindings); let dismissed = dismissedIds.contains(overrideFinding?.id ?? finding.id); return VStack(alignment: .leading, spacing: 7) {
    HStack { if fixed { Label("FIXED", systemImage: "checkmark.circle.fill").font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(.green).accessibilityLabel("Verified fixed") ; if let severity = finding.severity { badge("Was \(severity)", color: .secondary) } } else { if let severity = finding.severity { badge(severity, color: finding.lifecycle == "regressed" || severity == "CRITICAL" || severity == "HIGH" ? .red : .orange) }; badge(finding.lifecycle == "new" ? "New" : finding.lifecycle.capitalized, color: finding.lifecycle == "regressed" ? .red : .secondary) }; Spacer(); if dismissed { Text("Dismissed").font(.caption2) } else if let overrideFinding { Button("Dismiss") { onDismiss(finding, overrideFinding) }.controlSize(.small) } }
    Text(finding.claim).font(.callout.weight(.semibold)).strikethrough(dismissed).fixedSize(horizontal: false, vertical: true)
    if let path = finding.path { Text("\(path)\(finding.line.map { ":\($0)" } ?? "")\(finding.symbol.map { " · \($0)" } ?? "")").font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled) }
    if fixed, let resolution = finding.resolution { Text("Verified against HEAD \(String(resolution.reviewedHead.prefix(7)))").font(.caption.weight(.semibold)).foregroundStyle(.green); Text("Fix evidence: \(resolution.evidence)").font(.caption).textSelection(.enabled) }
    else if fixed, let closure = finding.closureEvidence { Text("Fix evidence: \(closure)").font(.caption).textSelection(.enabled) }
    if finding.evidence != nil || finding.remediation != nil || (!fixed && finding.closureEvidence != nil) { DisclosureGroup("Evidence & repair") { if let evidence = finding.evidence { Text(evidence).textSelection(.enabled) }; if let repair = finding.remediation { Text("Recommended repair: \(repair)").textSelection(.enabled) }; if !fixed, let closure = finding.closureEvidence { Text("Closure evidence: \(closure)").textSelection(.enabled) } }.font(.caption) }
  }.padding(10).background(fixed ? .green.opacity(0.1) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(fixed ? .green : finding.lifecycle == "regressed" ? .red : .gray.opacity(0.2))).accessibilityElement(children: .combine).accessibilityLabel(fixed ? "Verified fixed finding: \(finding.claim)" : "\(finding.lifecycle) finding: \(finding.claim)") }

  private var provenanceDecisions: some View { DisclosureGroup("Synthesis decisions") { ForEach(Array(council.rejected.enumerated()), id: \.offset) { _, item in Text("Rejected \(item.sourceIds.joined(separator: ", ")) — \(item.reason)").font(.caption).textSelection(.enabled) }; ForEach(Array(council.merged.enumerated()), id: \.offset) { _, item in Text("Merged \(item.sourceIds.joined(separator: ", ")) → \(item.finding.id)").font(.caption).textSelection(.enabled) } } }
  private var provenance: some View { DisclosureGroup("Provenance") { VStack(alignment: .leading, spacing: 3) { Text("Packet \(council.id) · diff \(String(council.diffHash.prefix(12))) · HEAD \(council.reviewedHead)"); Text("\(council.model) · schema \(council.schemaVersion) · prompt \(council.promptVersion) · \(council.synthesis)"); Text("Accepted \(council.acceptedCount) · rejected \(council.rejected.count) · merged \(council.merged.count) · \(duration(council.durationMs))") }.font(.system(.caption2, design: .monospaced)).textSelection(.enabled) } }
  private func count(_ state: ReviewCouncil.Filter) -> Int { council.lifecycleCounts[state] ?? 0 }; private func badge(_ text: String, color: Color) -> some View { Text(text).font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(color).padding(.horizontal, 5).padding(.vertical, 2).background(color.opacity(0.12), in: Capsule()) }; private func duration(_ ms: Int) -> String { String(format: "%.1fs", Double(ms) / 1000) }; private var cost: String { council.tokenUsage?.costUsd.map { String(format: " · $%.2f", $0) } ?? "" }
  private func axisFailureCopy(_ axis: ReviewAxisRunResponse) -> String { switch axis.failure?.kind { case "invalid-response": return "Invalid reviewer response"; case "timeout": return "Reviewer timed out"; case "provider-unavailable": return "Review provider unavailable"; case "runner-failed": return "Reviewer runner failed"; case "head-changed": return "Reviewed HEAD changed"; default: return axis.error ?? "Council runner unavailable" } }
  private func degradationCopy(_ reason: String) -> String { switch reason { case "REQUIRED_AXIS_UNAVAILABLE": return "A required axis did not complete"; case "SYNTHESIS_INVALID": return "Synthesis response was invalid"; case "SYNTHESIS_UNAVAILABLE": return "Synthesis did not complete"; case "REVIEWED_HEAD_CHANGED": return "Reviewed HEAD changed"; case "INITIAL_FINDING_UNMATCHED": return "A first-gate finding was not canonicalized"; default: return reason.replacingOccurrences(of: "_", with: " ").capitalized } }
  @ViewBuilder private func axisDuration(_ axis: ReviewAxisRunResponse) -> some View { if let durationMs = axis.durationMs { Text("Duration \(duration(durationMs))").font(.caption2).foregroundStyle(.tertiary) } else { Text("Duration unavailable").font(.caption2).foregroundStyle(.tertiary) } }
  private var synthesisLabel: String { switch council.synthesis { case "model": return "Model synthesis"; case "deterministic-fallback": return "Deterministic fallback"; default: return "Synthesis unavailable" } }
}
