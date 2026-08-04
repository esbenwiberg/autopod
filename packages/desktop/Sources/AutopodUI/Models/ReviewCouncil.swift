import Foundation
import AutopodClient

/// Stable, view-oriented representation of a frozen review batch. All three validation
/// entry points use this mapping so history and streamed results cannot drift.
public struct ReviewCouncil: Sendable {
  public enum Filter: String, Sendable, CaseIterable { case open, fixed, regressed, rejected, all }
  public struct Group: Sendable { public let axis: String?; public let findings: [Finding] }
  public struct Finding: Identifiable, Sendable {
    public let id: String; public let axis: String?; public let severity: String?; public let claim: String
    public let evidence: String?; public let remediation: String?; public let path: String?; public let line: Int?; public let symbol: String?
    public let lifecycle: String; public let sourceIds: [String]; public let closureEvidence: String?
    public var legacyIssue: String {
      guard let severity, let path else { return claim }
      return "[\(severity)] \(path)\(line.map { ":\($0)" } ?? "") — \(claim)"
    }
  }
  public let id: String; public let diffHash: String; public let reviewedHead: String; public let promptVersion: String; public let schemaVersion: String; public let model: String
  public let axes: [ReviewAxisRunResponse]; public let synthesis: String; public let durationMs: Int; public let tokenUsage: ReviewTokenUsageResponse?
  public let infrastructureUnavailable: Bool; public let overflow: FirstGateOverflowResponse?; public let findings: [Finding]
  public let hasLedger: Bool
  public let initialFindings: [InitialReviewFindingResponse]; public let rejected: [ReviewSynthesisRejectionResponse]; public let merged: [ReviewSynthesisMergeResponse]
  public let acceptedCount: Int
  public let repairDelta: ReviewRepairDeltaResponse?; public let closureVerification: ReviewClosureVerificationResponse?

  public init(
    _ batch: ReviewBatchResponse,
    overflow taskOverflow: FirstGateOverflowResponse? = nil,
    tokenUsage taskTokenUsage: ReviewTokenUsageResponse? = nil
  ) {
    id = batch.id; diffHash = batch.diffHash; reviewedHead = batch.reviewedHead; promptVersion = batch.promptVersion; schemaVersion = batch.schemaVersion; model = batch.model
    axes = batch.axes; synthesis = batch.synthesis; durationMs = batch.durationMs; tokenUsage = taskTokenUsage ?? batch.tokenUsage; infrastructureUnavailable = batch.infrastructureUnavailable ?? false
    overflow = taskOverflow ?? batch.firstGateOverflow; hasLedger = batch.ledger != nil; initialFindings = batch.initialFindings; rejected = batch.rejected; merged = batch.merged; acceptedCount = batch.accepted.count; repairDelta = batch.repairDelta; closureVerification = batch.closureVerification
    let records = batch.ledger.map { $0.map { ($0.semanticId, $0.finding, $0.state, $0.currentSourceIds, $0.closureEvidence) } }
      ?? batch.accepted.map { (Self.candidateId($0), $0, "open", [Self.candidateId($0)], nil) }
    findings = records.map { semanticId, candidate, state, sourceIds, closureEvidence in
      switch candidate {
      case .initial(let item): return Finding(id: semanticId, axis: nil, severity: nil, claim: item.issue, evidence: nil, remediation: nil, path: nil, line: nil, symbol: nil, lifecycle: state, sourceIds: sourceIds, closureEvidence: closureEvidence)
      case .structured(let item): return Finding(id: semanticId, axis: item.axis, severity: item.severity, claim: item.claim, evidence: item.evidence, remediation: item.remediation, path: item.path, line: item.line, symbol: item.symbol, lifecycle: state, sourceIds: sourceIds, closureEvidence: closureEvidence)
      }
    }
  }
  private static func candidateId(_ candidate: ReviewFindingCandidateResponse) -> String { switch candidate { case .initial(let item): item.id; case .structured(let item): item.id } }
  public var activeCount: Int { findings.filter { $0.lifecycle == "new" || $0.lifecycle == "open" || $0.lifecycle == "regressed" }.count }
  public var lifecycleCounts: [Filter: Int] {
    [.open: findings(filter: .open).count, .fixed: findings(filter: .fixed).count,
     .regressed: findings(filter: .regressed).count, .rejected: rejected.count,
     .all: findings.count + rejected.count]
  }
  public func findings(filter: Filter) -> [Finding] { findings(filter: filter.rawValue) }
  public func findings(filter: String) -> [Finding] {
    findings.filter { item in filter == "all" || (filter == "open" && ["new", "open"].contains(item.lifecycle)) || item.lifecycle == filter }
      .sorted {
        let leftAxis = axisRank($0.axis), rightAxis = axisRank($1.axis)
        if leftAxis != rightAxis { return leftAxis < rightAxis }
        let leftSeverity = severityRank($0.severity), rightSeverity = severityRank($1.severity)
        return leftSeverity == rightSeverity ? $0.id < $1.id : leftSeverity < rightSeverity
      }
  }
  private func axisRank(_ axis: String?) -> Int { ["contract_completeness", "security_authority", "lifecycle_reliability", "persistence_reproducibility", "tests_integration"].firstIndex(of: axis ?? "") ?? 5 }
  private func severityRank(_ severity: String?) -> Int { ["CRITICAL", "HIGH", "MEDIUM"].firstIndex(of: severity ?? "") ?? 3 }
  public func groups(filter: Filter) -> [Group] {
    let sorted = findings(filter: filter)
    let axes: [String?] = ["contract_completeness", "security_authority", "lifecycle_reliability", "persistence_reproducibility", "tests_integration", nil]
    return axes.compactMap { axis in
      let matches = sorted.filter { $0.axis == axis }
      return matches.isEmpty ? nil : Group(axis: axis, findings: matches)
    }
  }
  public func canonicalDismissFinding(for semanticId: String, in available: [ValidationFindingResponse]) -> ValidationFindingResponse? {
    guard overflow == nil else { return nil }
    return available.first { $0.id == semanticId }
  }
  public func canonicalDismissFinding(for finding: Finding, in available: [ValidationFindingResponse]) -> ValidationFindingResponse? {
    guard overflow == nil else { return nil }
    if let exact = available.first(where: { $0.id == finding.id }) { return exact }
    guard !hasLedger else { return nil }
    return available.first { $0.description == finding.legacyIssue || $0.description == finding.claim }
  }
}

public func reviewCouncil(from review: TaskReviewResponse?) -> ReviewCouncil? {
  guard let review, let batch = review.reviewBatch else { return nil }
  return ReviewCouncil(
    batch,
    overflow: review.firstGateOverflow,
    tokenUsage: review.tokenUsage
  )
}

public enum ReviewPresentationMode: Sendable, Equatable { case legacy, council }
public func reviewPresentationMode(council: ReviewCouncil?) -> ReviewPresentationMode {
  council == nil ? .legacy : .council
}

public func distinctBroadReviewIssues(_ issues: [String], council: ReviewCouncil?) -> [String] {
  guard let council else { return issues }
  let canonicalIssues = Set(council.findings.flatMap { [$0.claim, $0.legacyIssue] })
  return issues.filter { !canonicalIssues.contains($0) }
}
