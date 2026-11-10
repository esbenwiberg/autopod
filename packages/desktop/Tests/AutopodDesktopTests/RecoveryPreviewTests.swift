import AutopodClient
import AutopodUI
import Foundation
import Testing
@testable import AutopodDesktop

@MainActor @Suite(.serialized) struct RecoveryPreviewTests {
  @Test func offlineContinuationHasSeparateSampleChildHandoffAndSharedBudgetWithoutStartingOriginal() async throws {
    let fixture = DesktopRecoveryFixtures()
    defer { try? FileManager.default.removeItem(at: fixture.journalDirectory) }
    let actions = fixture.applying(to: .preview)
    let before = try await actions.sandboxRecovery.load(fixture.podId)
    let inspection = try await actions.recoveryFork.inspect(fixture.podId)
    try inspection.validate(podId: fixture.podId)
    let source = try #require(inspection.source)
    let file = try #require(source.files.first)
    let input = RecoveryForkInput(expectedGeneration: inspection.generation, sourceHead: source.head,
      executionProfileId: "sample-node-22", instructions: "Address the recorded Node mismatch, preserving the saved changes.",
      files: [RecoveryForkSelectedFile(path: file.path, version: file.version)], acknowledgePartialSource: true)
    let preview = try await actions.recoveryFork.preview(fixture.podId, input)
    try preview.validate(podId: fixture.podId, input: input)
    #expect(fixture.mutationCount == 0 && preview.budget?.taskId == inspection.budget?.taskId)
    let binding = try #require(preview.expectedBinding)
    let request = RecoveryForkRequest(expectedBinding: binding, input: input)
    let result = try await actions.recoveryFork.create(fixture.podId, request)
    try result.validate(podId: fixture.podId, request: request)
    #expect(result.childPodId != fixture.podId && result.state == .queued && result.context.messages.count == 2)
    #expect(try await actions.recoveryFork.create(fixture.podId, request) == result)
    let after = try await actions.sandboxRecovery.load(fixture.podId)
    #expect(before.resources.first?.providerState == after.resources.first?.providerState && fixture.mutationCount == 1)
    let held = try #require(after.resources.first)
    #expect(held.startBlocked != nil && held.abandonBlocked != nil)
    for action in ["start", "abandon"] {
      let sandboxRequest = SandboxRecoveryRequest(id: UUID().uuidString, action: action, sandboxId: held.sandboxId,
        expectedGeneration: after.generation, expectedResourceKey: held.resourceKey, reason: "No original release while continuation retains it", acknowledgeDataLoss: true)
      do { _ = try await actions.sandboxRecovery.submit(fixture.podId, sandboxRequest); Issue.record("Sample fork custody bypassed") } catch {}
    }
    #expect(fixture.mutationCount == 1)
    let preservedFiles = try await actions.fileRecovery.load(fixture.podId, false)
    #expect(preservedFiles.sources.first(where: { $0.id == "saved-workspace" })?.status == .available)
    #expect(preservedFiles.sources.first(where: { $0.id == "original" })?.status == .blocked)
    let child = try #require(result.childPodId)
    try await actions.recoveryFork.openPod(child)
    #expect(fixture.openedExample == child && fixture.continuationPod?.id == child)
    let childInspection = try await actions.recoveryFork.inspect(child)
    try childInspection.validate(podId: child)
    #expect(childInspection.lineage?.parentPodId == fixture.podId && childInspection.source == nil)
    #expect(childInspection.budget?.taskId == inspection.budget?.taskId)
  }
  @Test func sampleForkRefusesAnOriginalAlreadyStartedForFileRecovery() async throws {
    let fixture = DesktopRecoveryFixtures()
    defer { try? FileManager.default.removeItem(at: fixture.journalDirectory) }
    let actions = fixture.applying(to: .preview)
    let state = try await actions.sandboxRecovery.load(fixture.podId)
    let resource = try #require(state.resources.first)
    let request = SandboxRecoveryRequest(id: UUID().uuidString, action: "start", sandboxId: resource.sandboxId,
      expectedGeneration: state.generation, expectedResourceKey: resource.resourceKey, reason: "Read example files from the original")
    _ = try await actions.sandboxRecovery.submit(fixture.podId, request)
    #expect(!(try await actions.recoveryFork.inspect(fixture.podId)).available)
    #expect(fixture.mutationCount == 1 && fixture.continuationPod == nil)
  }
  @Test func previewTruthfullyRefusesUnsupportedSandboxCandidateWithoutMutation() async throws {
    let fixture = DesktopRecoveryFixtures()
    defer { try? FileManager.default.removeItem(at: fixture.journalDirectory) }
    let actions = fixture.applying(to: .preview).recoveryFork
    let inspection = try await actions.inspect(fixture.podId)
    let source = try #require(inspection.source)
    let input = RecoveryForkInput(expectedGeneration: inspection.generation, sourceHead: source.head,
      executionProfileId: "@original", instructions: "Use the original frozen environment after review.", files: [], acknowledgePartialSource: true)
    let result = try await actions.preview(fixture.podId, input)
    try result.validate(podId: fixture.podId, input: input)
    #expect(!result.available && result.expectedBinding == nil && result.execution == nil)
    #expect(result.blockers.first?.contains("Linux local-Docker") == true && fixture.mutationCount == 0)
  }
  @Test func sampleForkCannotBypassUnknownStartHoldOrScenarioChange() async throws {
    let fixture = DesktopRecoveryFixtures()
    defer { try? FileManager.default.removeItem(at: fixture.journalDirectory) }
    let old = fixture.applying(to: .preview).recoveryFork
    let inspection = try await old.inspect(fixture.podId)
    let source = try #require(inspection.source)
    let input = RecoveryForkInput(expectedGeneration: inspection.generation, sourceHead: source.head,
      executionProfileId: "sample-node-22", instructions: "Continue only after the frozen checkpoint is reviewed.", files: [], acknowledgePartialSource: true)
    let preview = try await old.preview(fixture.podId, input)
    let binding = try #require(preview.expectedBinding)
    fixture.scenario = .unknownStart
    let current = fixture.applying(to: .preview).recoveryFork
    #expect(!(try await current.inspect(fixture.podId)).available)
    do { _ = try await old.create(fixture.podId, RecoveryForkRequest(expectedBinding: binding, input: input)); Issue.record("Old scenario mutated") } catch {}
    do { _ = try await current.preview(fixture.podId, input); Issue.record("Unknown operation bypassed") } catch {}
    #expect(fixture.mutationCount == 0 && fixture.continuationPod == nil)
  }
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
      let files = try await actions.fileRecovery.load(fixture.podId, false)
      try files.validate(podId: fixture.podId)
      #expect(files.generation == fixture.generation && actions.fileRecovery.isFixture)
      #expect([sandbox.generation, stalled.generation, finalization.generation, repair.generation, checks.generation]
        .allSatisfy { $0 == fixture.generation })
      #expect(context.retained?.inspection?.generation == fixture.generation)
      #expect(!stalled.canStop && !finalization.canStop && !finalization.canCompleteMerged)
      #expect(!repair.available && !checks.fixValidation.allowed && !checks.retryChecks.allowed)
      #expect(actions.sandboxRecovery.journalDirectory?.path.hasPrefix(directory.path) == true)
      #expect(fixture.mutationCount == 0)
    }
  }

  @Test func previewOriginalFilesRequireExplicitStartAndListingAndRemainSampleData() async throws {
    let fixture = DesktopRecoveryFixtures()
    let actions = fixture.applying(to: .preview)
    let before = try await actions.fileRecovery.load(fixture.podId, false)
    #expect(before.sources.first { $0.kind == .original }?.status == .stopped)
    let state = try await actions.sandboxRecovery.load(fixture.podId)
    let resource = try #require(state.resources.first)
    _ = try await actions.sandboxRecovery.submit(fixture.podId, SandboxRecoveryRequest(action: "start",
      sandboxId: resource.sandboxId, expectedGeneration: state.generation, expectedResourceKey: resource.resourceKey,
      reason: "Inspect the example original files"))
    let metadata = try await actions.fileRecovery.load(fixture.podId, false)
    #expect(metadata.sources.first { $0.kind == .original }?.status == .ready)
    #expect(metadata.sources.first { $0.kind == .original }?.files.isEmpty == true)
    let listed = try await actions.fileRecovery.load(fixture.podId, true)
    let source = try #require(listed.sources.first { $0.kind == .original })
    let file = try #require(source.files.first { $0.path == "notes.bin" })
    let bytes = try await actions.fileRecovery.read(fixture.podId, RecoveryFileSelection(source: source, generation: listed.generation, file: file))
    #expect(Data(base64Encoded: bytes.content) == Data([0, 255, 128, 10, 3]))
    fixture.scenario = .held
    #expect(!actions.fileRecovery.isCurrent())
    await #expect(throws: DaemonError.self) { try await actions.fileRecovery.load(fixture.podId, true) }
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
