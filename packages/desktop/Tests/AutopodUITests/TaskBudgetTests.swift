import AppKit
import AutopodClient
import SwiftUI
import Testing

@testable import AutopodUI

@Suite(.serialized) @MainActor struct TaskBudgetTests {
  @Test func onlyHigherSafeIntegerWithHeadroomCanBeSaved() async throws {
    let fixture = TaskBudgetUIFixture()
    let model = TaskBudgetModel(podId: "repair", scope: fixture.actions.scope)
    #expect(!model.canSave)
    await model.refresh(fixture.actions)
    for input in [
      "", "0", "-1", "100", "200", "1.5", "3e6", " 300", "9007199254740992",
      "999999999999999999999",
    ] {
      model.limit = input
      #expect(!model.canSave)
      #expect(await model.save(fixture.actions) == false)
    }
    #expect(fixture.requests.isEmpty)
    model.limit = "300"
    #expect(model.canSave)
    #expect(await model.save(fixture.actions))
    #expect(fixture.requests == [.init(tokenBudget: 300, expectedBudget: 100)])
    #expect(model.snapshot?.tokenBudget == 300)
    #expect(!model.canSave)
  }

  @Test(arguments: [false, true]) func failedOrLostMutationRequiresRefresh(lost: Bool) async throws
  {
    let fixture = TaskBudgetUIFixture()
    let model = TaskBudgetModel(podId: "repair", scope: fixture.actions.scope)
    await model.refresh(fixture.actions)
    fixture.failure =
      lost ? URLError(.networkConnectionLost) : DaemonError.serverError(409, "Task budget changed")
    model.limit = "300"
    #expect(await model.save(fixture.actions) == false)
    #expect(model.requiresRefresh && !model.canSave)
    #expect(model.limit == "300")
    #expect(model.error?.contains("No continuation was requested") == true)
    #expect(await model.save(fixture.actions) == false)
    #expect(fixture.requests.count == 1)
    fixture.budget = 250
    fixture.failure = nil
    await model.refresh(fixture.actions)
    #expect(model.limit == "300" && model.canSave)
    #expect(await model.save(fixture.actions))
    #expect(fixture.requests.last?.expectedBudget == 250)
  }

  @Test func budgetLoadFailureCannotEnableMutation() async throws {
    let fixture = TaskBudgetUIFixture()
    let unavailable = TaskBudgetActions(
      scope: "fixture",
      load: { _ in
        throw DaemonError.notFound("Task budget API unavailable")
      }, raise: fixture.actions.raise)
    let model = TaskBudgetModel(podId: "repair", scope: unavailable.scope)
    await model.refresh(unavailable)
    model.limit = "300"
    model.removeLimit = true
    #expect(!model.canSave && model.snapshot == nil && model.requiresRefresh)
    #expect(model.error?.contains("API unavailable") == true)
    #expect(await model.save(unavailable) == false)
    #expect(fixture.requests.isEmpty)
  }

  @Test func removalUsesExplicitUnlimitedAndDoesNotRewriteConfiguration() async throws {
    let fixture = TaskBudgetUIFixture()
    let model = TaskBudgetModel(podId: "repair", scope: fixture.actions.scope)
    await model.refresh(fixture.actions)
    model.removeLimit = true
    #expect(await model.save(fixture.actions))
    #expect(fixture.requests == [.init(tokenBudget: nil, expectedBudget: 100)])
    #expect(model.snapshot?.tokenBudget == nil && !model.canSave)
    #expect(fixture.events == ["budget"])
  }

  @Test func cannotReplayOnAnotherConnectionOrSubmitTwiceWhilePending() async throws {
    let fixture = TaskBudgetUIFixture()
    let model = TaskBudgetModel(podId: "repair", scope: fixture.actions.scope)
    await model.refresh(fixture.actions)
    model.limit = "300"
    let foreign = TaskBudgetActions(
      scope: "other", load: fixture.actions.load, raise: fixture.actions.raise)
    #expect(await model.save(foreign) == false)
    #expect(fixture.requests.isEmpty && model.error?.contains("Connection changed") == true)
    await model.refresh(fixture.actions)
    fixture.hold = true
    let first = Task { await model.save(fixture.actions) }
    while fixture.continuation == nil { await Task.yield() }
    #expect(model.busy)
    #expect(await model.save(fixture.actions) == false)
    fixture.continuation?.resume()
    #expect(await first.value)
    #expect(fixture.requests.count == 1)
  }

  @Test func nativeUnlimitedRequiresConfirmationBeforeMutation() async throws {
    let fixture = TaskBudgetUIFixture()
    let model = TaskBudgetModel(podId: "repair", scope: fixture.actions.scope)
    let host = LaunchComposerHost(
      TaskBudgetControls(podId: "repair", actions: fixture.actions, model: model), width: 560)
    defer { host.close() }
    try await host.wait { host.has("task-budget-unlimited") }
    try host.press("task-budget-unlimited")
    try await host.wait { host.enabled("task-budget-save") }
    try host.press("task-budget-save")
    try await host.wait { !host.window.sheets.isEmpty }
    #expect(fixture.requests.isEmpty)
    func buttons(_ view: NSView) -> [NSButton] {
      (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
    }
    let sheet = try #require(host.window.sheets.first?.contentView)
    let confirm = try #require(buttons(sheet).first { $0.title == "Remove limit" })
    confirm.performClick(nil)
    try await host.wait { model.snapshot?.tokenBudget == nil && !fixture.requests.isEmpty }
    #expect(fixture.requests == [.init(tokenBudget: nil, expectedBudget: 100)])
    #expect(fixture.events == ["budget"])
  }

  @Test(arguments: [360.0, 560.0])
  func nativeEditorValidatesAndSavesWithoutStartingExecution(width: Double) async throws {
    let fixture = TaskBudgetUIFixture()
    let model = TaskBudgetModel(podId: "repair", scope: fixture.actions.scope)
    let host = LaunchComposerHost(
      TaskBudgetControls(podId: "repair", actions: fixture.actions, model: model), width: width,
      light: width == 560)
    defer { host.close() }
    try await host.wait { host.has("task-budget-limit") }
    #expect(!host.enabled("task-budget-save"))
    try host.editField(placeholder: "New total token limit", text: "300")
    try await host.wait { host.enabled("task-budget-save") }
    #expect(host.hosting.fittingSize.width <= width)
    try host.capture("task-budget-editor-\(Int(width))")
    try host.press("task-budget-save")
    try await host.wait { model.snapshot?.tokenBudget == 300 }
    #expect(fixture.events == ["budget"])
    #expect(!host.enabled("task-budget-save"))
    try host.capture("task-budget-saved-\(Int(width))")
  }

  @Test(
    arguments: ["accepted", "budget-rejected", "recovery-rejected"],
    [PodRepairKind.rework, .revalidate, .resume])
  func nativeHandoffContinuesOnlyAfterConfirmedBudgetSave(outcome: String, kind: PodRepairKind)
    async throws
  {
    let fixture = TaskBudgetUIFixture()
    if outcome == "budget-rejected" {
      fixture.failure = DaemonError.serverError(409, "Task budget changed; refresh and try again")
    }
    var actions = PodActions()
    actions.taskBudget = fixture.actions
    actions.repair = PodRepairActions(
      scope: "fixture",
      submit: { _, kind, _ in
        fixture.events.append(kind.rawValue)
        if outcome == "recovery-rejected" {
          throw DaemonError.serverError(409, "This pod has uncollected human guidance. Use Rework.")
        }
        return PodRepairReceipt(message: "Request accepted; checks still apply.")
      }, inspect: { _ in throw URLError(.unsupportedURL) })
    let pod = Pod(
      id: "repair", status: .failed, hasWorktree: true,
      branch: "feature", profileName: "test", task: "Finish validation", model: "test",
      startedAt: .now)
    let repair = PodRepairModel(kind: kind, scope: actions.repair.scope)
    let host = LaunchComposerHost(
      PodRepairSheet(
        isPresented: .constant(true), pod: pod, kind: kind,
        relatedPods: [], actions: actions, model: repair), width: 1120)
    defer { host.close() }
    try await host.wait { host.has("task-budget-limit") }
    try host.editField(placeholder: "New total token limit", text: "300")
    try await host.wait { host.enabled("task-budget-save-continue") }
    try host.press("task-budget-save-continue")
    try await host.wait { !fixture.requests.isEmpty && !host.enabled("task-budget-save-continue") }
    if outcome == "budget-rejected" {
      #expect(repair.receipt == nil && fixture.events == ["budget"])
      #expect(host.containsText("Task budget changed"))
      try host.capture("task-budget-conflict")
    } else if outcome == "recovery-rejected" {
      try await host.wait { repair.error != nil }
      #expect(fixture.events == ["budget", kind.rawValue] && fixture.budget == 300)
      #expect(repair.receipt == nil && !repair.uncertain)
      #expect(host.containsText("uncollected human guidance"))
      try host.capture("task-budget-recovery-rejected")
    } else {
      try await host.wait { repair.receipt != nil }
      #expect(fixture.events == ["budget", kind.rawValue])
      try host.capture("task-budget-\(kind.rawValue)-accepted")
    }
  }
}

@MainActor private final class TaskBudgetUIFixture {
  var budget: Int? = 100
  var requests: [TaskBudgetChangeRequest] = []
  var events: [String] = []
  var failure: (any Error)?
  var hold = false
  var continuation: CheckedContinuation<Void, Never>?
  func snapshot() throws -> TaskExecutionSummary {
    try JSONDecoder().decode(
      TaskExecutionSummary.self,
      from: Data(
        """
        {"taskId":"task","executionId":"execution","rootPodId":"root","podCount":2,
        "agentRunCount":1,"failedRunCount":0,"transientFailureCount":0,"providerAttemptCount":1,
        "validationExecutionCount":0,"tokenBudget":\(budget.map(String.init) ?? "null"),
        "budgetCheck":{"status":"\(budget.map { $0 <= 200 ? "exhausted" : "below_recorded_limit" } ?? "unlimited")","reason":"Recorded task usage includes cached input."},
        "recordedInputTokens":190,"recordedOutputTokens":10,"recordedTotalTokens":200,
        "recordedCostUsd":1.28,"telemetry":"partial","diagnostics":[]}
        """.utf8))
  }
  var actions: TaskBudgetActions {
    TaskBudgetActions(
      scope: "fixture", load: { _ in try self.snapshot() },
      raise: { id, request in
        #expect(id == "repair")
        self.requests.append(request)
        self.events.append("budget")
        if self.hold { await withCheckedContinuation { self.continuation = $0 } }
        if let failure = self.failure { throw failure }
        #expect(request.expectedBudget == self.budget)
        self.budget = request.tokenBudget
        return try self.snapshot()
      })
  }
}
