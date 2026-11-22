import AutopodClient
import Foundation
import Observation

struct ParentFamilyScope: Hashable, Sendable {
  let connectionID: UUID
  let parent: String
}

@MainActor
@Observable
final class ParentFamilyModel {
  static func scope(
    parent: String,
    isWorkspace: Bool,
    connectionID: UUID?
  ) -> ParentFamilyScope? {
    guard !isWorkspace, let connectionID else { return nil }
    return ParentFamilyScope(connectionID: connectionID, parent: parent)
  }

  private(set) var family: ParentManagedFamily?
  private(set) var isLoading = false
  private(set) var isStale = false
  private(set) var lastError: String?

  private var scope: ParentFamilyScope?
  private var requestID = UUID()

  func family(for candidateScope: ParentFamilyScope?) -> ParentManagedFamily? {
    guard scope == candidateScope else { return nil }
    return family
  }

  func invalidate() {
    requestID = UUID()
    scope = nil
    family = nil
    isLoading = false
    isStale = false
    lastError = nil
  }

  func load(
    parent: String,
    connectionID: UUID,
    using loader: @escaping @MainActor @Sendable (String) async throws -> ParentManagedFamily?
  ) async {
    let requestedScope = ParentFamilyScope(connectionID: connectionID, parent: parent)
    if scope != requestedScope {
      scope = requestedScope
      family = nil
      isStale = false
      lastError = nil
    }

    let currentRequestID = UUID()
    requestID = currentRequestID
    isLoading = true
    defer {
      if accepts(currentRequestID, scope: requestedScope) {
        isLoading = false
      }
    }

    do {
      let result = try await loader(parent)
      guard accepts(currentRequestID, scope: requestedScope), !Task.isCancelled else { return }
      guard result?.parent == parent || result == nil else {
        throw URLError(.badServerResponse)
      }
      family = result
      isStale = false
      lastError = nil
    } catch is CancellationError {
      // A replacement task owns presentation now.
    } catch {
      guard accepts(currentRequestID, scope: requestedScope), !Task.isCancelled else { return }
      lastError = error.localizedDescription
      isStale = family != nil
    }
  }

  static func loadKey(for scope: ParentFamilyScope?, status: PodStatus) -> String? {
    scope.map { "\($0.connectionID):\($0.parent):\(status.rawValue)" }
  }

  func observe(
    _ scope: ParentFamilyScope,
    using loader: @escaping @MainActor @Sendable (String) async throws -> ParentManagedFamily?,
    pause: @MainActor () async throws -> Void = { try await Task.sleep(for: .seconds(5)) }
  ) async {
    guard !Task.isCancelled else { return }
    await load(parent: scope.parent, connectionID: scope.connectionID, using: loader)
    var discovered = family(for: scope) != nil
    var discoveryRetries = 2
    // An initially unavailable family gets a short, bounded discovery window.
    // Only an authorized, known family (including an empty one) polls thereafter.
    while !Task.isCancelled, self.scope == scope {
      let known = family(for: scope) != nil
      if !known && (discovered || discoveryRetries == 0) { return }
      do { try await pause() } catch { return }
      guard !Task.isCancelled, self.scope == scope else { return }
      if !isLoading {
        if family(for: scope) == nil {
          if discovered { return }
          discoveryRetries -= 1
        }
        await load(parent: scope.parent, connectionID: scope.connectionID, using: loader)
        discovered = discovered || family(for: scope) != nil
      }
    }
  }

  private func accepts(_ candidate: UUID, scope candidateScope: ParentFamilyScope) -> Bool {
    requestID == candidate && scope == candidateScope
  }
}

struct ParentManagedChildPresentation: Equatable {
  let title: String
  let detail: String
  let symbol: String
  let tone: ParentManagedChildTone

  let collection: String?

  init(_ child: ParentManagedChild) {
    if child.status == .exited && child.exitCode == 0 {
      switch child.collectionStatus {
      case "collected": collection = "Commit collected"
      case "pending": collection = "Collecting commit"
      case "unavailable": collection = "No commit collected"
      default: collection = nil
      }
    } else {
      collection = nil
    }
    switch child.status {
    case .reserved:
      title = "Reserved"
      detail = child.child == nil ? "Waiting for a child task ID" : "Child ID assigned"
      symbol = "clock.badge.questionmark"
      tone = .reserved
    case .started:
      title = "Started"
      detail = "Child task started"
      symbol = "play.circle.fill"
      tone = .started
    case .exited:
      title = "Exited"
      let limitReached = child.exitReason == "provider-request-limit"
      if limitReached {
        detail = "Child used all allowed model requests before finishing."
      } else if let code = child.exitCode, (0...255).contains(code) {
        detail = "Exit code \(code)"
      } else {
        detail = "Child task exited"
      }
      symbol = limitReached ? "exclamationmark.circle.fill" : "stop.circle.fill"
      tone = limitReached ? .limited : .exited
    case .unknown:
      title = "Unknown"
      detail = "Daemon could not determine child state"
      symbol = "questionmark.circle.fill"
      tone = .unknown
    }
  }
}

enum ParentManagedChildTone: Equatable {
  case reserved, started, exited, limited, unknown
}

struct ParentReviewPresentation: Equatable {
  let title: String
  let detail: String
  let commit: String?
  let evidence: String?

  init(_ review: ParentManagedReview, isStale: Bool) {
    let ready = !isStale && review.status == .ready
      && Self.isHex(review.commit, prefix: "", count: 40)
      && Self.isHex(review.evidenceDigest, prefix: "sha256:", count: 64)
    commit = ready ? review.commit : nil
    evidence = ready ? review.evidenceDigest : nil
    if isStale {
      (title, detail) = ("Review status not current", "Refresh the family to check the latest review state.")
      return
    }
    switch review.status {
    case .waiting:
      (title, detail) = ("Waiting for coding results", "Checks start after both coding results are retained.")
    case .reserved:
      (title, detail) = ("Checks queued", "The exact pair of coding results is reserved for checks.")
    case .checks:
      (title, detail) = ("Running checks", "The checks evaluator is assessing the integrated change.")
    case .independentReview:
      (title, detail) = ("Independent review", "Checks passed. Independent review is in progress.")
    case .ready where ready:
      (title, detail) = ("Tested change ready for review", "Checks and independent review passed. Nothing was published.")
    case .failed:
      (title, detail) = ("Qualification stopped", "No tested change is available from this run.")
    case .notSent:
      (title, detail) = ("Evaluation not sent", "The daemon restarted before sending the request. No retry was started.")
    case .unknown:
      (title, detail) = ("Evaluation outcome unknown", "The daemon could not confirm the result. No retry was started.")
    case .candidateUnavailable:
      (title, detail) = ("Coding result unavailable", "At least one coding child has no verified result for checks.")
    case .notConfigured:
      (title, detail) = ("Automatic checks not configured", "This run does not have automatic qualification enabled.")
    case .ready, .unavailable, .unsupported:
      (title, detail) = ("Review unavailable", "There is no current verified change to review.")
    }
  }

  private static func isHex(_ value: String?, prefix: String, count: Int) -> Bool {
    guard let value, value.hasPrefix(prefix) else { return false }
    let hex = value.utf8.dropFirst(prefix.utf8.count)
    return hex.count == count && hex.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
}
