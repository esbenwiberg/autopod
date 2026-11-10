import AutopodClient
import AutopodUI
import Foundation
import Testing
@testable import AutopodDesktop

@MainActor @Suite(.serialized) struct RecoveryPreviewTests {
  @Test func allScenariosSupplyCorrelatedObservationsWithoutExecutionAuthority() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = DesktopRecoveryFixtures(journalDirectory: directory)
    for scenario in DesktopRecoveryFixtures.Scenario.allCases {
      fixture.scenario = scenario
      let actions = fixture.applying(to: .preview)
      let sandbox = try await actions.sandboxRecovery.load(fixture.podId)
      let stalled = try await actions.stalledWorkerRecovery.load(fixture.podId)
      let finalization = try await actions.retainedFinalization.load(fixture.podId)
      let repair = try await actions.repairContinuation.load(fixture.podId)
      try repair.validate(podId: fixture.podId)
      let context = try await actions.repairContinuation.context(fixture.podId)
      let checks = try await actions.loadValidationRecovery(fixture.podId)
      #expect([sandbox.generation, stalled.generation, finalization.generation, repair.generation, checks.generation]
        .allSatisfy { $0 == fixture.generation })
      #expect(context.retained?.inspection?.generation == fixture.generation)
      #expect(!stalled.canStop && !finalization.canStop && !finalization.canCompleteMerged)
      #expect(!repair.available && !checks.fixValidation.allowed && !checks.retryChecks.allowed)
      #expect(actions.sandboxRecovery.journalDirectory?.path.hasPrefix(directory.path) == true)
      #expect(fixture.mutationCount == 0)
    }
  }

  @Test func simulatedStartAndExactReplayCannotRunASecondOperation() async throws {
    let fixture = DesktopRecoveryFixtures()
    let actions = fixture.applying(to: .preview)
    let snapshot = try await actions.sandboxRecovery.load(fixture.podId)
    let resource = try #require(snapshot.resources.first)
    let request = SandboxRecoveryRequest(action: "start", sandboxId: resource.sandboxId,
      expectedGeneration: snapshot.generation, expectedResourceKey: resource.resourceKey,
      reason: "Inspect the sample workspace only")
    let first = try await actions.sandboxRecovery.submit(fixture.podId, request)
    let replay = try await actions.sandboxRecovery.submit(fixture.podId, request)
    #expect(first.operation.id == replay.operation.id && first.operation.completedAt != nil)
    #expect(!first.podDeleted && fixture.mutationCount == 1)
    #expect(try await actions.sandboxRecovery.load(fixture.podId).resources.first?.providerState == "running")
    let changed = SandboxRecoveryRequest(id: request.id, action: request.action, sandboxId: request.sandboxId,
      expectedGeneration: request.expectedGeneration, expectedResourceKey: request.expectedResourceKey,
      reason: "A different decision cannot reuse the saved key")
    await #expect(throws: DaemonError.self) { try await actions.sandboxRecovery.submit(fixture.podId, changed) }
    #expect(fixture.mutationCount == 1)
  }

  @Test func unknownStartCannotReplayButExplicitDiscardRemainsOnlyASimulation() async throws {
    let fixture = DesktopRecoveryFixtures()
    fixture.scenario = .unknownStart
    let actions = fixture.applying(to: .preview)
    let snapshot = try await actions.sandboxRecovery.load(fixture.podId)
    let resource = try #require(snapshot.resources.first)
    #expect(!resource.pendingIntentIds.isEmpty && resource.startBlocked != nil && resource.abandonBlocked == nil)
    let start = SandboxRecoveryRequest(action: "start", sandboxId: resource.sandboxId,
      expectedGeneration: snapshot.generation, expectedResourceKey: resource.resourceKey,
      reason: "Do not blindly replay the sample start")
    await #expect(throws: DaemonError.self) { try await actions.sandboxRecovery.submit(fixture.podId, start) }
    let noConsent = SandboxRecoveryRequest(action: "abandon", sandboxId: resource.sandboxId,
      expectedGeneration: snapshot.generation, expectedResourceKey: resource.resourceKey,
      reason: "Discard this sample without pretending files were preserved")
    await #expect(throws: DaemonError.self) { try await actions.sandboxRecovery.submit(fixture.podId, noConsent) }
    let discard = SandboxRecoveryRequest(action: "abandon", sandboxId: resource.sandboxId,
      expectedGeneration: snapshot.generation, expectedResourceKey: resource.resourceKey,
      reason: noConsent.reason, acknowledgeDataLoss: true)
    let result = try await actions.sandboxRecovery.submit(fixture.podId, discard)
    #expect(!result.podDeleted && result.cleanupError?.contains("No real pod") == true)
    let after = try await actions.sandboxRecovery.load(fixture.podId)
    #expect(after.resources.first?.providerState == "deleted")
    #expect(after.operations.contains { $0.action == "start" && $0.completedAt == nil })
    #expect(fixture.mutationCount == 1)
  }

  @Test func changingTheScenarioInvalidatesOpenActionsAndHeldCleanupStaysBlocked() async throws {
    let fixture = DesktopRecoveryFixtures()
    let old = fixture.applying(to: .preview)
    let snapshot = try await old.sandboxRecovery.load(fixture.podId)
    let resource = try #require(snapshot.resources.first)
    let request = SandboxRecoveryRequest(action: "abandon", sandboxId: resource.sandboxId,
      expectedGeneration: snapshot.generation, expectedResourceKey: resource.resourceKey,
      reason: "Old scenario must not target the new one", acknowledgeDataLoss: true)
    fixture.scenario = .held
    #expect(!old.sandboxRecovery.isCurrent())
    await #expect(throws: DaemonError.self) { try await old.sandboxRecovery.submit(fixture.podId, request) }
    let current = fixture.applying(to: .preview)
    let held = try await current.sandboxRecovery.load(fixture.podId)
    #expect(held.resources.first?.abandonBlocked != nil)
    await #expect(throws: DaemonError.self) { try await current.sandboxRecovery.submit(fixture.podId, request) }
    #expect(fixture.mutationCount == 0)
  }

  @Test func offlineConnectionManagerRejectsAllNetworkAndAuthEntrypoints() async throws {
    let manager = ConnectionManager(restoreConnection: true, allowLiveConnections: false)
    let url = try #require(URL(string: "https://offline-preview.invalid"))
    #expect(!manager.allowsLiveConnections && manager.api == nil && manager.connection == nil)
    await #expect(throws: DaemonError.self) { try await manager.addAndConnect(name: "Sample", url: url, token: "") }
    await #expect(throws: DaemonError.self) { try await manager.connect(to: UUID()) }
    await #expect(throws: DaemonError.self) { try await manager.signInWithMicrosoft() }
    switch await manager.testConnection(url: url, token: "") {
    case .success: Issue.record("A fixture must not test a live endpoint")
    case .failure(let error): #expect(error.localizedDescription.contains("sample-data preview"))
    }
    #expect(await manager.recoverAuthentication() == false)
    manager.handleDeepLink(try #require(URL(string: "\(DesktopIdentity.deepLinkScheme)://connect?url=https%3A%2F%2Foffline-preview.invalid")))
    #expect(manager.api == nil && manager.connection == nil && manager.activeToken == nil)
    let provider = manager.makeAccessTokenProvider()
    await #expect(throws: DaemonError.self) { try await provider() }
  }

  @Test func disabledProviderCannotFallBackToCliOrAuthAfterManagerDeallocation() async throws {
    var manager: ConnectionManager? = ConnectionManager(restoreConnection: false, allowLiveConnections: false)
    let provider = try #require(manager?.makeAccessTokenProvider())
    manager = nil
    await #expect(throws: DaemonError.self) { try await provider() }
  }
}
