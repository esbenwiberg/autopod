import AutopodClient
import Foundation
import Observation

public struct TaskBudgetActions: Sendable {
  public let scope: String
  public var load: @MainActor @Sendable (String) async throws -> TaskExecutionSummary
  public var raise:
    @MainActor @Sendable (String, TaskBudgetChangeRequest) async throws -> TaskExecutionSummary

  public init(
    scope: String,
    load: @escaping @MainActor @Sendable (String) async throws -> TaskExecutionSummary,
    raise:
      @escaping @MainActor @Sendable (String, TaskBudgetChangeRequest) async throws ->
      TaskExecutionSummary
  ) {
    self.scope = scope
    self.load = load
    self.raise = raise
  }

  public static let unavailable = Self(
    scope: "unavailable",
    load: { _ in
      throw DaemonError.networkError("Task budget is unavailable on this connection.")
    },
    raise: { _, _ in
      throw DaemonError.networkError("Task budget controls are unavailable on this connection.")
    })
}

@Observable @MainActor internal final class TaskBudgetModel {
  let podId: String
  private let scope: String
  var limit = ""
  var removeLimit = false
  private(set) var snapshot: TaskExecutionSummary?
  private(set) var busy = false
  private(set) var requiresRefresh = false
  private(set) var error: String?
  private(set) var message: String?

  init(podId: String, scope: String) {
    self.podId = podId
    self.scope = scope
  }

  // Match JavaScript's safe-integer boundary, not Swift's wider Int range.
  private var proposedLimit: Int? {
    guard !limit.isEmpty, limit.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
      let value = Int(limit), value > 0, value <= 9_007_199_254_740_991
    else { return nil }
    return value
  }

  var validation: String? {
    guard let snapshot else { return "Load the current task budget before changing it." }
    guard let current = snapshot.tokenBudget else { return "This task already has no token limit." }
    guard !requiresRefresh else { return "Refresh the task budget before trying again." }
    if removeLimit { return nil }
    guard let value = proposedLimit else {
      return "Enter a positive whole token count (up to 9007199254740991)."
    }
    guard value > current else { return "Choose a limit higher than the current task limit." }
    guard value > snapshot.totalRecordedTokens else {
      return "Choose a limit above the task’s recorded usage."
    }
    return nil
  }

  var canSave: Bool { !busy && validation == nil }

  func refresh(_ actions: TaskBudgetActions) async {
    guard !busy, bind(actions) else { return }
    busy = true
    defer { busy = false }
    do {
      let value = try await actions.load(podId)
      snapshot = value
      requiresRefresh = false
      error = nil
      // Keep the operator's draft across a conflict or uncertain response.
      if limit.isEmpty { limit = value.tokenBudget.map(String.init) ?? "" }
    } catch {
      requiresRefresh = true
      self.error = error.localizedDescription
    }
  }

  /// Only a confirmed mutation permits an explicitly requested continuation.
  func save(_ actions: TaskBudgetActions) async -> Bool {
    guard bind(actions), canSave, let snapshot else { return false }
    let request = TaskBudgetChangeRequest(
      tokenBudget: removeLimit ? nil : proposedLimit, expectedBudget: snapshot.tokenBudget)
    busy = true
    requiresRefresh = true
    error = nil
    message = nil
    defer { busy = false }
    do {
      self.snapshot = try await actions.raise(podId, request)
      requiresRefresh = false
      message = "Task budget saved. Saving the budget alone does not start execution."
      return true
    } catch {
      self.error =
        "\(error.localizedDescription) Refresh to check the current budget before retrying. No continuation was requested."
      return false
    }
  }

  private func bind(_ actions: TaskBudgetActions) -> Bool {
    guard scope == actions.scope else {
      requiresRefresh = true
      error = "Connection changed. Reopen the task budget on the current daemon."
      return false
    }
    return true
  }
}
