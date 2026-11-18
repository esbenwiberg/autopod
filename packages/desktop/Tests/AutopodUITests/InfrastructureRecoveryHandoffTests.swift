import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct InfrastructureRecoveryHandoffTests {
  private func eligibility(held: Bool = true) throws -> ReworkEligibility {
    try JSONDecoder().decode(ReworkEligibility.self, from: Data("""
      {"eligible":\(!held),"status":"\(held ? "blocked" : "eligible")","reason":"Recorded lifecycle hold",\
      "generation":3,"failureId":null,"code":\(held ? "\"INFRASTRUCTURE_BLOCKED\"" : "null")}
      """.utf8))
  }
  private func context(generation: Int = 3) throws -> RepairRetainedContext {
    try JSONDecoder().decode(RepairRetainedContext.self, from: Data("""
      {"inspection":{"generation":\(generation),"infrastructure":{"state":"reported","truncated":false,\
      "needs":[{"id":"report-1","owner":"validation","phase":"test","needs":"Diagnose runner heap and reaping","truncated":false}]},\
      "prerequisites":{"sourcePreservationRecorded":true,"workerSettlementRecorded":true,"pendingDecision":false}}}
      """.utf8))
  }

  @Test func inspectionLoadsRecordedNeedsWithoutGrantingOrDispatchingOrdinaryRecovery() async throws {
    let held = try eligibility()
    let details = try context()
    let model = PodRepairModel(kind: .rework, ordinaryRework: true)
    var reads = 0
    var actions = PodRepairActions(submit: { _, _, _ in
      Issue.record("Infrastructure inspection cannot dispatch ordinary recovery")
      return PodRepairReceipt(message: "unexpected")
    }, inspect: { _ in throw URLError(.unsupportedURL) })
    actions.loadReworkEligibility = { _ in held }
    actions.inspectInfrastructure = { _ in reads += 1; return details }
    await model.refreshEligibility(id: "fixture", actions: actions)
    #expect(reads == 1 && model.infrastructureBlocked && !model.canSubmit)
    #expect(model.infrastructureContext?.inspection?.infrastructure.needs.first?.id == "report-1")
    await model.submit(id: "fixture", actions: actions)
    #expect(model.receipt == nil)
    let pod = Pod(id: "fixture", status: .failed, hasWorktree: true, branch: "fixture",
      profileName: "fixture", task: "Retain source", model: "fixture", startedAt: .now)
    var podActions = PodActions(); podActions.repair = actions
    let host = LaunchComposerHost(PodRepairSheet(isPresented: .constant(true), pod: pod,
      kind: .rework, relatedPods: [], actions: podActions, model: model), width: 1120)
    defer { host.close() }
    try await host.wait { host.has("repair-infrastructure-handoff") && !model.eligibilityLoading }
    #expect(host.has("repair-infrastructure-command"))
    #expect(host.enabled("repair-infrastructure-copy"))
    #expect(!host.enabled("repair-submit"))
    #expect(!host.has("task-budget-save-continue"))
    #expect(!host.has("repair-infrastructure-replacement")) // Unavailable route is not offered.
    #expect(!host.has("repair-continuation-guidance"))
    try host.capture("infrastructure-recovery-handoff")
  }

  @Test func unknownAndStaleContextCannotDischargeTheHoldAndRefreshClearsOldReports() async throws {
    let held = try eligibility()
    let eligible = try eligibility(held: false)
    let stale = try context(generation: 2)
    let current = try context()
    let model = PodRepairModel(kind: .resume, ordinaryRework: true)
    var actions = PodRepairActions(submit: { _, _, _ in
      Issue.record("Context reads are not continuation authority"); return PodRepairReceipt(message: "unexpected")
    }, inspect: { _ in throw URLError(.unsupportedURL) })
    actions.loadReworkEligibility = { _ in held }
    actions.inspectInfrastructure = { _ in stale }
    await model.refreshEligibility(id: "fixture", actions: actions)
    #expect(model.infrastructureContext == nil && model.infrastructureInspectionError != nil && !model.canSubmit)
    actions.inspectInfrastructure = { _ in current }
    await model.refreshEligibility(id: "fixture", actions: actions)
    #expect(model.infrastructureContext != nil)
    actions.inspectInfrastructure = { _ in throw URLError(.notConnectedToInternet) }
    await model.refreshEligibility(id: "fixture", actions: actions)
    #expect(model.infrastructureContext == nil && model.infrastructureInspectionError != nil && !model.canSubmit)
    actions.loadReworkEligibility = { _ in eligible }
    actions.inspectInfrastructure = { _ in Issue.record("No infrastructure report read for non-held lifecycle"); return current }
    await model.refreshEligibility(id: "fixture", actions: actions)
    #expect(model.infrastructureContext == nil && model.infrastructureInspectionError == nil && !model.infrastructureBlocked)
  }

  @Test func replacementLinkOnlyHandsOffToSeparateInspection() async throws {
    var opened = 0
    let host = LaunchComposerHost(InfrastructureRecoveryHandoff(podId: "fixture", context: try context(),
      inspectionError: nil, canReviewReplacement: true, onReviewReplacement: { opened += 1 }), width: 800)
    defer { host.close() }
    try await host.wait { host.enabled("repair-infrastructure-replacement") }
    #expect(opened == 0)
    try host.press("repair-infrastructure-replacement")
    #expect(opened == 1)
    try host.capture("infrastructure-recovery-details")
  }

  @Test func inspectionCommandQuotesPodIdentityAndNeverAppliesOrReconciles() {
    #expect(InfrastructureRecoveryHandoff.inspectionCommand(podId: "solar-cardinal") == "autopod recover-infrastructure 'solar-cardinal' --json")
    let command = InfrastructureRecoveryHandoff.inspectionCommand(podId: "x'; touch /tmp/not-a-command; '")
    #expect(command.contains("'\\''"))
    #expect(!command.contains("--apply") && !command.contains("--reconcile"))
  }

  @Test func copiedCommandPassesIdentityAsOneLiteralShellArgument() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent("autopod")
    try Data("#!/bin/sh\nprintf '%s\\n' \"$@\"\n".utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    let unexpected = root.appendingPathComponent("unexpected")
    let podId = "fixture'; : > \(unexpected.path); printf '"
    let process = Process(); let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", InfrastructureRecoveryHandoff.inspectionCommand(podId: podId)]
    process.environment = ["PATH": root.path]; process.standardOutput = output
    try process.run(); process.waitUntilExit()
    #expect(process.terminationStatus == 0)
    let actual = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    #expect(actual == "recover-infrastructure\n\(podId)\n--json\n")
    #expect(!FileManager.default.fileExists(atPath: unexpected.path))
  }
}
