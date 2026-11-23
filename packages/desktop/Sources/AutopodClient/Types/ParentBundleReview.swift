import Foundation

/// The exact tested result advertised by one parent family's owner projection.
public struct ParentBundleSelection: Hashable, Sendable {
  public let parentId: String
  public let run: String
  public let evidenceDigest: String
  public let commit: String

  public init?(parentId: String, run: String, evidenceDigest: String, commit: String) {
    guard parentId.range(of: #"\A[a-zA-Z0-9_-]{1,128}\z"#, options: .regularExpression) != nil,
      !run.isEmpty, run.utf8.count <= 160,
      Self.isHex(evidenceDigest, prefix: "sha256:", count: 64),
      Self.isHex(commit, prefix: "", count: 40) else { return nil }
    self.parentId = parentId
    self.run = run
    self.evidenceDigest = evidenceDigest
    self.commit = commit
  }

  var reviewPath: String { "/orchestration/parents/\(parentId)/review/\(evidenceDigest)" }

  static func isHex(_ value: String, prefix: String = "sha256:", count: Int = 64) -> Bool {
    guard value.hasPrefix(prefix) else { return false }
    let hex = value.utf8.dropFirst(prefix.utf8.count)
    return hex.count == count && hex.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
}

public struct ParentBundleReview: Decodable, Equatable, Sendable {
  public let run: String
  public let parentId: String
  public let evidenceDigest: String
  public let commit: String
  public let tree: String
  public let bundleDigest: String
  public let bundleBaseCommit: String?
  public let paths: [String]
  public let checks: String
  public let independentReview: String
  public let reviewDigest: String

  public func matches(_ selection: ParentBundleSelection) -> Bool {
    parentId == selection.parentId && run == selection.run
      && evidenceDigest == selection.evidenceDigest && commit == selection.commit
      && ParentBundleSelection.isHex(tree, prefix: "", count: 40)
      && (bundleBaseCommit.map { $0 != commit && ParentBundleSelection.isHex($0, prefix: "", count: 40) } ?? true)
      && [bundleDigest, checks, independentReview, reviewDigest].allSatisfy { ParentBundleSelection.isHex($0) }
      && !paths.isEmpty && paths.count <= 2048
      && paths.allSatisfy { !$0.isEmpty && $0.utf16.count <= 4096 }
  }
}

struct ParentBundleDecision: Encodable {
  let evidenceDigest: String
  let expectedReviewDigest: String
}

public struct ParentBundleApproval: Decodable, Equatable, Sendable {
  public let review: ParentBundleReview
  public let approvalDigest: String
  public let approvedAt: Int

  public func matches(_ preview: ParentBundleReview) -> Bool {
    review == preview && ParentBundleSelection.isHex(approvalDigest) && approvedAt > 0
  }
}
