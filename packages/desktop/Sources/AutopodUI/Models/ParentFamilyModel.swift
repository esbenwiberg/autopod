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

  init(_ child: ParentManagedChild) {
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
      detail = "Child task exited"
      symbol = "stop.circle.fill"
      tone = .exited
    case .unknown:
      title = "Unknown"
      detail = "Daemon could not determine child state"
      symbol = "questionmark.circle.fill"
      tone = .unknown
    }
  }
}

enum ParentManagedChildTone: Equatable {
  case reserved, started, exited, unknown
}
