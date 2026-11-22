import AppKit
import AutopodClient
import SwiftUI
import Testing

@testable import AutopodUI

@Suite(.serialized) @MainActor struct TaskBudgetTests {
  @Test func aCacheWeightedIncreaseDoesNotRequireExceedingRawRecordedUsage() async throws {
    let fixture = TaskBudgetUIFixture()
    fixture.countedTokens = 120
    let model = TaskBudgetModel(podId: "repair", scope: fixture.actions.scope)
    await model.refresh(fixture.actions)
    #expect(model.snapshot?.totalRecordedTokens == 200)
    #expect(model.snapshot?.tokensCountedForBudget == 120)
    model.limit = "120"
    #expect(!model.canSave)
    model.limit = "150"
    #expect(model.canSave)
    #expect(await model.save(fixture.actions))
    #expect(fixture.requests == [.init(tokenBudget: 150, expectedBudget: 100)])
  }

  @Test func hardBudgetStopRoutesCodingSeparatelyFromChecks() {
    let stopped = Pod(id: "cap-stop", status: .failed, branch: "fix", profileName: "test",
      task: "Continue saved work", model: "test", startedAt: .now,
      errorSummary: "Token budget exceeded (1503606/1500000 tokens used).")
    #expect(stopped.isBudgetStopped)
    var unrelated = stopped
    unrelated.errorSummary = "Test assertion failed"
    #expect(!unrelated.isBudgetStopped)
    unrelated.errorSummary = stopped.errorSummary
    unrelated.status = .running
    #expect(!unrelated.isBudgetStopped)
  }

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
    arguments: ["accepted", "budget-rejected", "recovery-rejected", "retry-blocked", "retry-unavailable"],
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
    actions.retryDraftScope = UUID().uuidString
    defer { UserDefaults.standard.removeObject(forKey: "autopod.rework-v1.\(actions.retryDraftScope).repair.worker") }
    actions.repair = PodRepairActions(
      scope: "fixture",
      submit: { _, kind, _ in
        fixture.events.append(kind.rawValue)
        if outcome == "recovery-rejected" {
          throw DaemonError.serverError(409, "This pod has uncollected human guidance. Use Rework.")
        }
        return PodRepairReceipt(message: "Request accepted; checks still apply.")
      }, inspect: { _ in throw URLError(.unsupportedURL) })
    let eligibility = try JSONDecoder().decode(ReworkEligibility.self, from: Data("""
      {"eligible":\(outcome != "retry-blocked"),"status":"\(outcome == "retry-blocked" ? "blocked" : "eligible")","reason":"Daemon retry admission projection","generation":1}
      """.utf8))
    actions.repair.loadReworkEligibility = { _ in
      if outcome == "retry-unavailable" { throw DaemonError.notFound("older daemon") }
      return eligibility
    }
    actions.repair.submitRework = { _, request in
      fixture.events.append(PodRepairKind.rework.rawValue)
      if outcome == "recovery-rejected" { throw DaemonError.serverError(409, "This pod has uncollected human guidance. Use Rework.") }
      return try JSONDecoder().decode(ReworkRequestReceipt.self, from: JSONEncoder().encode(request))
    }
    let pod = Pod(
      id: "repair", status: .failed, hasWorktree: true,
      branch: "feature", profileName: "test", task: "Finish validation", model: "test",
      startedAt: .now)
    let repair = PodRepairModel(kind: kind, scope: actions.repair.scope, ordinaryRework: kind == .rework)
    let host = LaunchComposerHost(
      PodRepairSheet(
        isPresented: Binding(get: { fixture.presented }, set: { fixture.presented = $0 }),
        pod: pod, kind: kind,
        relatedPods: [], actions: actions, model: repair), width: 1120)
    defer { host.close() }
    try await host.wait { host.has("task-budget-limit") }
    try host.editField(placeholder: "New total token limit", text: "300")
    if kind == .rework && ["retry-blocked", "retry-unavailable"].contains(outcome) {
      try await host.wait { !repair.eligibilityLoading && host.enabled("task-budget-save") }
      #expect(!host.has("task-budget-save-continue") && !host.enabled("repair-submit"))
      await repair.submit(id: pod.id, actions: actions.repair)
      #expect(fixture.requests.isEmpty && fixture.events.isEmpty)
      return
    }
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
      try await host.wait { repair.receipt != nil && (kind != .resume || !fixture.presented) }
      #expect(fixture.presented == (kind != .resume))
      #expect(fixture.events == ["budget", kind.rawValue])
      try host.capture("task-budget-\(kind.rawValue)-accepted")
    }
  }
}

@MainActor private final class TaskBudgetUIFixture {
  var presented = true
  var budget: Int? = 100
  var countedTokens: Int?
  var cachedTokens: Int?
  var loadFailure: (any Error)?
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
        "budgetCheck":{"status":"\(budget.map { $0 <= (countedTokens ?? 200) ? "exhausted" : "below_recorded_limit" } ?? "unlimited")","reason":"Recorded task usage includes cached input."},
        "recordedInputTokens":190,"recordedOutputTokens":10,"recordedTotalTokens":200,
        "budgetCountedTokens":\(countedTokens.map(String.init) ?? "null"),
        "recordedCachedInputTokens":\(cachedTokens.map(String.init) ?? "null"),
        "recordedCostUsd":1.28,"telemetry":"partial","diagnostics":[]}
        """.utf8))
  }
  var actions: TaskBudgetActions {
    TaskBudgetActions(
      scope: "fixture",
      load: { _ in
        if let failure = self.loadFailure { throw failure }
        return try self.snapshot()
      },
      raise: { id, request in
        #expect(id == "repair")
        self.requests.append(request)
        self.events.append("budget")
        if self.hold { await withCheckedContinuation { self.continuation = $0 } }
        if let failure = self.failure { throw failure }
        #expect(request.expectedBudget == self.budget)
        self.budget = request.tokenBudget
        return try self.snapshot()
      },
      approvePause: { id in
        #expect(id == "repair")
        self.events.append("continue")
        if let failure = self.failure { throw failure }
        return BudgetContinuationResponse(budgetExtensionsUsed: 1, maxBudgetExtensions: 3)
      })
  }
}

// MARK: - Work → Cost task token limit (#641, #567)

@Suite(.serialized) @MainActor struct TaskTokenLimitCostTests {
  private func pod(status: PodStatus = .running, pauseReason: String? = nil) -> Pod {
    var pod = Pod(
      id: "repair", status: status, branch: "feature", profileName: "test",
      task: "Finish the feature", model: "test", startedAt: .now)
    pod.pauseReason = pauseReason
    return pod
  }

  private let breakdown = PodCostBreakdownResponse(
    podId: "repair", model: "test-model", totalCostUsd: 1.5, inputTokens: 190, outputTokens: 10,
    segments: [
      PodCostSegment(
        bucket: "work", label: "Work", costUsd: 1.5, inputTokens: 190, outputTokens: 10,
        sourcePhases: ["agent_initial"])
    ])

  /// Opens Work → Cost in a WorkTab whose cost loader either returns metrics or fails.
  private func costTab(
    _ fixture: TaskBudgetUIFixture, pod: Pod? = nil, costAvailable: Bool = true,
    width: Double = 760
  ) async throws -> LaunchComposerHost {
    var actions = PodActions()
    actions.taskBudget = fixture.actions
    let breakdown = breakdown
    let view = WorkTab(
      pod: pod ?? self.pod(), actions: actions,
      loadCost: { _ in
        guard costAvailable else { throw DaemonError.notFound("Cost telemetry unavailable") }
        return breakdown
      })
    let host = LaunchComposerHost(view, width: width)
    try await host.wait { host.has("work-section-cost") }
    try host.press("work-section-cost")
    return host
  }

  private func text(_ host: LaunchComposerHost, _ id: String) -> String {
    guard let node = host.matches(id).first else { return "" }
    let label = node.responds(to: NSSelectorFromString("accessibilityLabel"))
      ? node.value(forKey: "accessibilityLabel") as? String : nil
    let value = node.responds(to: NSSelectorFromString("accessibilityValue"))
      ? node.value(forKey: "accessibilityValue") as? String : nil
    return [label, value].compactMap { $0 }.joined(separator: " ")
  }

  private func frame(_ host: LaunchComposerHost, _ id: String) throws -> NSRect {
    let node = try #require(host.matches(id).first)
    return try #require((node.value(forKey: "accessibilityFrame") as? NSValue)?.rectValue)
  }

  @Test(arguments: [400.0, 480.0, 760.0])
  func limitSitsDirectlyBeneathCostMetricsAndStartsCollapsed(width: Double) async throws {
    let fixture = TaskBudgetUIFixture()
    let host = try await costTab(fixture, width: width)
    defer { host.close() }
    try await host.wait { host.has("work-cost-metrics") && host.has("task-token-limit-value") }
    // Screen coordinates grow upward: the limit section must be wholly below the metrics.
    let metrics = try frame(host, "work-cost-metrics")
    let limit = try frame(host, "task-token-limit")
    #expect(limit.maxY <= metrics.minY + 0.5)
    #expect(limit.width > 0 && limit.width <= metrics.width + 0.5)
    #expect(text(host, "task-token-limit-value").contains("100"))
    #expect(text(host, "task-token-limit-used").contains("200"))
    #expect(host.has("task-token-limit-increase") && host.has("task-token-limit-remove"))
    #expect(!host.has("task-token-limit-field"))
    #expect(host.containsText("not a dollar cap"))
    #expect(host.containsText("linked repair pods (2 pods)"))
    #expect(host.hosting.fittingSize.width <= width)
    #expect(fixture.requests.isEmpty)
    try host.capture("cost-token-limit-\(Int(width))")
  }

  @Test func unlimitedTaskShowsNoLimitWithoutEditingControls() async throws {
    let fixture = TaskBudgetUIFixture()
    fixture.budget = nil
    let host = try await costTab(fixture)
    defer { host.close() }
    try await host.wait { host.has("task-token-limit-value") }
    #expect(text(host, "task-token-limit-value").contains("No limit"))
    #expect(!host.has("task-token-limit-increase") && !host.has("task-token-limit-remove"))
  }

  @Test func missingCostTelemetryKeepsBudgetSection() async throws {
    let fixture = TaskBudgetUIFixture()
    let host = try await costTab(fixture, costAvailable: false, width: 480)
    defer { host.close() }
    try await host.wait {
      host.containsText("Cost metrics unavailable") && host.has("task-token-limit-value")
    }
    #expect(!host.has("work-cost-metrics"))
    #expect(text(host, "task-token-limit-value").contains("100"))
    #expect(host.has("task-token-limit-increase"))
    try host.capture("cost-token-limit-missing-cost")
  }

  @Test func budgetLoadFailureIsUnavailableNotNoLimit() async throws {
    let fixture = TaskBudgetUIFixture()
    fixture.loadFailure = DaemonError.notFound("Task budget API unavailable")
    let host = try await costTab(fixture)
    defer { host.close() }
    try await host.wait { host.has("task-token-limit-unavailable") }
    #expect(host.has("work-cost-metrics"))
    #expect(!host.containsText("No limit"))
    #expect(!host.has("task-token-limit-increase") && !host.has("task-token-limit-remove"))
    #expect(host.containsText("Task budget API unavailable"))
    fixture.loadFailure = nil
    try host.press("task-token-limit-error-refresh")
    try await host.wait { host.has("task-token-limit-value") }
    #expect(!host.has("task-token-limit-unavailable"))
  }

  @Test(arguments: [400.0, 760.0])
  func increaseValidatesAndShowsSavedLimitImmediately(width: Double) async throws {
    let fixture = TaskBudgetUIFixture()
    let host = try await costTab(fixture, width: width)
    defer { host.close() }
    try await host.wait { host.has("task-token-limit-increase") }
    try host.press("task-token-limit-increase")
    try await host.wait { host.has("task-token-limit-field") }
    #expect(!host.enabled("task-token-limit-save"))
    for invalid in ["50", "150", "1.5", "-1"] {
      try host.editField(placeholder: "New total token limit", text: invalid)
      try await host.wait { !host.enabled("task-token-limit-save") }
    }
    #expect(host.containsText("budget-counted usage") || host.containsText("positive whole"))
    try host.editField(placeholder: "New total token limit", text: "300")
    try await host.wait { host.enabled("task-token-limit-save") }
    #expect(host.hosting.fittingSize.width <= width)
    try host.capture("cost-token-limit-editor-\(Int(width))")
    try host.press("task-token-limit-save")
    try await host.wait {
      !host.has("task-token-limit-field") && text(host, "task-token-limit-value").contains("300")
    }
    #expect(fixture.requests == [.init(tokenBudget: 300, expectedBudget: 100)])
    #expect(fixture.events == ["budget"])
    #expect(host.containsText("does not start execution"))
    try host.capture("cost-token-limit-saved-\(Int(width))")
  }

  @Test func removeRequiresConfirmationAndShowsNoLimit() async throws {
    let fixture = TaskBudgetUIFixture()
    let host = try await costTab(fixture)
    defer { host.close() }
    try await host.wait { host.enabled("task-token-limit-remove") }
    try host.press("task-token-limit-remove")
    try await host.wait { !host.window.sheets.isEmpty }
    #expect(fixture.requests.isEmpty)
    func buttons(_ view: NSView) -> [NSButton] {
      (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
    }
    let sheet = try #require(host.window.sheets.first?.contentView)
    let confirm = try #require(buttons(sheet).first { $0.title == "Remove limit" })
    confirm.performClick(nil)
    try await host.wait { text(host, "task-token-limit-value").contains("No limit") }
    #expect(fixture.requests == [.init(tokenBudget: nil, expectedBudget: 100)])
    #expect(fixture.events == ["budget"])
    #expect(!host.has("task-token-limit-remove"))
  }

  @Test func conflictShowsErrorAndRequiresRefreshBeforeRetry() async throws {
    let fixture = TaskBudgetUIFixture()
    fixture.failure = DaemonError.serverError(409, "Task budget changed; refresh and try again")
    let host = try await costTab(fixture)
    defer { host.close() }
    try await host.wait { host.has("task-token-limit-increase") }
    try host.press("task-token-limit-increase")
    try await host.wait { host.has("task-token-limit-field") }
    try host.editField(placeholder: "New total token limit", text: "300")
    try await host.wait { host.enabled("task-token-limit-save") }
    try host.press("task-token-limit-save")
    try await host.wait { host.has("task-token-limit-error") }
    #expect(host.containsText("Task budget changed"))
    #expect(!host.enabled("task-token-limit-save") && !host.enabled("task-token-limit-remove"))
    // Another operator raised the limit meanwhile; refresh adopts it before retrying.
    fixture.failure = nil
    fixture.budget = 250
    try host.press("task-token-limit-error-refresh")
    try await host.wait { host.enabled("task-token-limit-save") }
    #expect(text(host, "task-token-limit-value").contains("250"))
    try host.press("task-token-limit-save")
    try await host.wait { text(host, "task-token-limit-value").contains("300") }
    #expect(fixture.requests.map(\.expectedBudget) == [100, 250])
  }

  @Test func showsBudgetCountedFigureBesideRawTotalAndCacheReads() async throws {
    let fixture = TaskBudgetUIFixture()
    fixture.countedTokens = 120
    fixture.cachedTokens = 89
    let host = try await costTab(fixture, width: 480)
    defer { host.close() }
    try await host.wait { host.has("task-token-limit-usage-detail") }
    #expect(text(host, "task-token-limit-used").contains("120"))
    #expect(
      text(host, "task-token-limit-usage-detail").contains("200 recorded incl. 89 cache reads at 0.1×"))
  }

  @Test func usageDetailMirrorsSharedDescription() throws {
    let fixture = TaskBudgetUIFixture()
    #expect(try fixture.snapshot().budgetUsageDetail == nil)
    fixture.cachedTokens = 89
    // Older daemons omit budgetCountedTokens: the raw total is compared and nothing is discounted.
    #expect(try fixture.snapshot().budgetUsageDetail == nil)
    fixture.countedTokens = 120
    #expect(
      try fixture.snapshot().budgetUsageDetail == "200 recorded incl. 89 cache reads at 0.1×")
  }

  @Test func budgetPausedPodCanBeApprovedFromCostTab() async throws {
    let fixture = TaskBudgetUIFixture()
    let host = try await costTab(fixture, pod: pod(status: .paused, pauseReason: "budget"))
    defer { host.close() }
    try await host.wait { host.enabled("task-token-limit-approve-pause") }
    try host.capture("cost-token-limit-budget-paused")
    try host.press("task-token-limit-approve-pause")
    try await host.wait { !host.has("task-token-limit-approve-pause") }
    #expect(fixture.events == ["continue"] && fixture.requests.isEmpty)
    #expect(text(host, "task-token-limit-message").contains("Budget extension approved (1/3 used)"))
  }

  @Test func budgetPauseApprovalFailureIsShownAndOfferedAgain() async throws {
    let fixture = TaskBudgetUIFixture()
    fixture.failure = DaemonError.serverError(409, "maximum budget extensions (3)")
    let host = try await costTab(fixture, pod: pod(status: .paused, pauseReason: "budget"))
    defer { host.close() }
    try await host.wait { host.enabled("task-token-limit-approve-pause") }
    try host.press("task-token-limit-approve-pause")
    try await host.wait { host.has("task-token-limit-error") }
    #expect(host.containsText("maximum budget extensions"))
    #expect(host.has("task-token-limit-approve-pause"))
  }

  @Test(arguments: [(PodStatus.paused, "manual"), (.paused, String?.none), (.running, String?.none)] as [(PodStatus, String?)])
  func approvalIsOnlyOfferedForBudgetPause(status: PodStatus, reason: String?) async throws {
    let fixture = TaskBudgetUIFixture()
    let host = try await costTab(fixture, pod: pod(status: status, pauseReason: reason))
    defer { host.close() }
    try await host.wait { host.has("task-token-limit-value") }
    #expect(!host.has("task-token-limit-approve-pause"))
  }
}
