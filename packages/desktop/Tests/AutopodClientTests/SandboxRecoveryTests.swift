import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop
import AutopodUI

private let recoveryReceipt = #"{"id":"decision","podId":"pod","sandboxId":"sandbox","resourceKey":"https://azure.invalid/sandboxes/sandbox","generation":2,"action":"abandon","userId":"human","reason":"Discard retained sandbox reports","createdAt":"2026-11-01T12:00:00Z","completedAt":"2026-11-01T12:00:01Z"}"#
private let recoveryState = #"{"podId":"pod","generation":2,"resources":[{"sandboxId":"sandbox","resourceKey":"https://azure.invalid/sandboxes/sandbox","providerState":"stopped","observedAt":"2026-11-01T12:00:00Z","observationError":null,"pendingIntentIds":["wakeup"],"startBlocked":"Original resume outcome is unknown","abandonBlocked":null,"abandonment":null}],"operations":[],"wakeups":[{"id":"wakeup","sandboxId":"sandbox","startedAt":"2026-10-30T20:31:06Z","dispatchStartedAt":"2026-10-30T20:31:06Z","endedAt":null,"settledBy":null,"evidence":[]}] }"#

@MainActor @Suite struct SandboxRecoveryTests {
  @Test func typedInspectionIsReadOnlyAndPreservesUnknownEvidence() async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let task = f.startResult {
        do {
          let state = try await handler.actions.sandboxRecovery.load("pod")
          #expect(state.generation == 2)
          #expect(state.resources[0].startBlocked != nil)
          #expect(state.resources[0].abandonBlocked == nil)
          #expect(state.wakeups[0].endedAt == nil && state.wakeups[0].evidence.isEmpty)
          return "observed"
        } catch { return error.localizedDescription }
      }
      try await f.next(f.a, "/pods/pod/sandbox-recovery").respond(body: recoveryState)
      #expect(await task.value == "observed")
      #expect(f.a.requests.count == 1)
      #expect(f.a.requests.allSatisfy { $0.httpMethod == "GET" })
    }
  }

  @Test func acknowledgementAndExactResourceBindingSurviveEncodingAndReceiptReplay() throws {
    let receipt = try JSONDecoder().decode(SandboxRecoveryReceipt.self, from: Data(recoveryReceipt.utf8))
    let request = SandboxRecoveryRequest(abandonment: receipt)
    let roundtrip = try JSONDecoder().decode(SandboxRecoveryRequest.self, from: JSONEncoder().encode(request))
    #expect(roundtrip == request)
    #expect(request.id == receipt.id)
    #expect(request.expectedGeneration == receipt.generation)
    #expect(request.expectedResourceKey == receipt.resourceKey)
    #expect(request.acknowledgeDataLoss)
    #expect(request.reason == receipt.reason)
    let start = SandboxRecoveryRequest(action: "start", sandboxId: "sandbox", expectedGeneration: 2,
      expectedResourceKey: receipt.resourceKey, reason: "Inspect retained files")
    #expect(!start.acknowledgeDataLoss)
  }

  @Test(arguments: [false, true])
  func submitUsesOnlyRecoveryEndpointAndRemovesPodOnlyOnConfirmedCleanup(deleted: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("pod")
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let input = try JSONDecoder().decode(SandboxRecoveryReceipt.self, from: Data(recoveryReceipt.utf8))
      let task = f.startResult {
        do {
          let result = try await handler.actions.sandboxRecovery.submit("pod", SandboxRecoveryRequest(abandonment: input))
          #expect(result.podDeleted == deleted)
          return "accepted"
        } catch { return error.localizedDescription }
      }
      let post = try await f.a.next()
      #expect(post.request.httpMethod == "POST")
      #expect(post.request.url?.path == "/pods/pod/sandbox-recovery")
      #expect(post.request.timeoutInterval == 180)
      post.respond(body: "{\"operation\":\(recoveryReceipt),\"podDeleted\":\(deleted),\"cleanupError\":\(deleted ? "null" : "\"Other custody remains held\"")}")
      #expect(await task.value == "accepted")
      #expect(f.store.pods.isEmpty == deleted)
      #expect(f.a.requests.count == 1)
    }
  }

  @Test(arguments: [200, 404, 503], [false, true])
  func resultsAndErrorsCannotCrossConnections(status: Int, mutation: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("pod")
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let receipt = try JSONDecoder().decode(SandboxRecoveryReceipt.self, from: Data(recoveryReceipt.utf8))
      let task = f.startResult {
        do {
          if mutation { _ = try await handler.actions.sandboxRecovery.submit("pod", SandboxRecoveryRequest(abandonment: receipt)) }
          else { _ = try await handler.actions.sandboxRecovery.load("pod") }
          return "unexpected acceptance"
        } catch { return error.localizedDescription }
      }
      let response = try await f.a.next()
      f.store.configure(api: f.apiB)
      f.seed("pod", task: "new connection")
      let body = status == 200 ? (mutation ? "{\"operation\":\(recoveryReceipt),\"podDeleted\":true,\"cleanupError\":null}" : recoveryState) : #"{"error":"old connection"}"#
      response.respond(status: status, body: body)
      #expect(await task.value?.contains("Connection changed") == true)
      #expect(f.store.pods.first?.task == "new connection")
      #expect(f.b.requests.isEmpty)
      let oldScope = handler.actions.sandboxRecovery.scope
      let current = ActionHandler(api: f.apiB, podStore: f.store, profileStore: ProfileStore())
      #expect(current.actions.sandboxRecovery.scope != oldScope)
    }
  }

  @Test func desktopControlsRequireFreshCapabilityReasonAndDestructiveConsent() throws {
    let state = try JSONDecoder().decode(SandboxRecoveryState.self, from: Data(recoveryState.utf8))
    let held = state.resources[0]
    #expect(!SandboxRecoveryControlPolicy.canStart(held, reason: "Recover retained files", busy: false))
    #expect(!SandboxRecoveryControlPolicy.canAbandon(held, currentUserId: "human", reason: "Discard retained files", acceptsLoss: false, busy: false))
    #expect(!SandboxRecoveryControlPolicy.canAbandon(held, currentUserId: "human", reason: "short", acceptsLoss: true, busy: false))
    #expect(!SandboxRecoveryControlPolicy.canAbandon(held, currentUserId: "human", reason: "Discard retained files", acceptsLoss: true, busy: true))
    #expect(SandboxRecoveryControlPolicy.canAbandon(held, currentUserId: "human", reason: "Discard retained files", acceptsLoss: true, busy: false))
    let readyJSON = recoveryState.replacingOccurrences(of: "\"pendingIntentIds\":[\"wakeup\"]", with: "\"pendingIntentIds\":[]")
      .replacingOccurrences(of: "\"startBlocked\":\"Original resume outcome is unknown\"", with: "\"startBlocked\":null")
    let ready = try JSONDecoder().decode(SandboxRecoveryState.self, from: Data(readyJSON.utf8)).resources[0]
    #expect(SandboxRecoveryControlPolicy.canStart(ready, reason: "Recover retained files", busy: false))
    #expect(!SandboxRecoveryControlPolicy.canStart(ready, reason: "Recover retained files", busy: true))
    for providerState in ["unknown", "deleted", "running", "future-state"] {
      let json = readyJSON.replacingOccurrences(of: "\"providerState\":\"stopped\"", with: "\"providerState\":\"\(providerState)\"")
      let resource = try JSONDecoder().decode(SandboxRecoveryState.self, from: Data(json.utf8)).resources[0]
      #expect(!SandboxRecoveryControlPolicy.canStart(resource, reason: "Recover retained files", busy: false))
    }
  }

  @Test func obsoleteRecoveryControlsCannotSendAnything() async throws {
    try await withPodStoreLifetimeFixture { f in
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      f.store.configure(api: f.apiA)
      do { _ = try await handler.actions.sandboxRecovery.load("pod"); Issue.record("Accepted obsolete inspection") }
      catch { #expect(error.localizedDescription.contains("Connection changed")) }
      let receipt = try JSONDecoder().decode(SandboxRecoveryReceipt.self, from: Data(recoveryReceipt.utf8))
      do { _ = try await handler.actions.sandboxRecovery.submit("pod", SandboxRecoveryRequest(abandonment: receipt)); Issue.record("Accepted obsolete mutation") }
      catch { #expect(error.localizedDescription.contains("Connection changed")) }
      #expect(f.a.requests.isEmpty && f.b.requests.isEmpty)
    }
  }
}
