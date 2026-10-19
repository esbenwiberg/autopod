import Foundation
import Testing
import AutopodClient
import AutopodUI
@testable import AutopodDesktop

@MainActor @Suite struct FollowUpTransportTests {
  @Test(arguments: PodRepairKind.allCases)
  func acceptedRepairUsesItsExistingEndpointWithoutInventingRunningState(kind: PodRepairKind) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("source")
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let task = f.track(Task { () -> PodRepairReceipt? in try? await handler.actions.repair.submit("source", kind, "Reviewer feedback") })
      let post = try await f.a.next()
      let suffix: String = switch kind { case .manual: "fix-manually"; case .rework: "validate"; case .revalidate: "revalidate"; case .resume: "resume"; case .prFix: "spawn-fix" }
      #expect(post.request.url?.path == "/pods/source/\(suffix)" && post.request.httpMethod == "POST")
      if kind == .prFix {
        let data = try #require(followUpBody(post.request))
        let json = try JSONDecoder().decode(ConfigurationJSON.self, from: data)
        #expect(json["message"]?.string == "Reviewer feedback")
      } else { #expect(post.request.httpBody == nil) }
      switch kind {
      case .manual: post.respond(body: lifetimePod(id: "workspace"))
      case .rework: post.respond(status: 202, body: #"{"ok":true,"accepted":true}"#)
      case .revalidate: post.respond(body: #"{"newCommits":true,"result":"validating"}"#)
      case .resume: post.respond(body: #"{"ok":true,"action":"revalidate"}"#)
      case .prFix: post.respond(body: #"{"ok":true,"queued":true,"queueLength":3,"fixPodId":"fix-pod"}"#)
      }
      let receipt = try #require(await task.value)
      #expect(f.store.pods.first { $0.id == "source" }?.status == .running)
      #expect(receipt.podID == (kind == .manual ? "workspace" : kind == .prFix ? "fix-pod" : nil))
      #expect(receipt.unreadFeedback == (kind == .prFix ? 3 : nil))
      #expect(f.a.requests.count == 1 && f.b.requests.isEmpty)
    }
  }
  @Test(arguments: [false, true])
  func connectionSwitchFencesRepairAdmissionAndLateResponse(switchBefore: Bool) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.seed("source")
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let actions = handler.actions.repair
      if switchBefore { f.store.configure(api: f.apiB) }
      let task = f.track(Task { () -> PodRepairReceipt? in try? await actions.submit("source", .manual, nil) })
      if !switchBefore {
        let post = try await f.a.next()
        f.store.configure(api: f.apiB)
        post.respond(body: lifetimePod(id: "workspace"))
      }
      #expect(await task.value == nil)
      #expect(!f.store.pods.contains { $0.id == "workspace" })
      #expect(f.a.requests.count == (switchBefore ? 0 : 1) && f.b.requests.isEmpty)
    }
  }
  @Test func launchConfigurationClosuresStayBoundToTheirDaemon() async throws {
    try await withPodStoreLifetimeFixture { f in
      let store = LaunchConfigurationStore(); store.configure(api: f.apiA)
      let actions = store.actions { _ in }
      let task = f.track(Task { () -> String? in
        do { return try await actions.readLaunch("source").digest } catch { return nil }
      })
      let get = try await f.a.next()
      store.configure(api: f.apiB)
      get.respond(body: connectionLaunchConfiguration)
      #expect(await task.value == nil)
      let stale = f.track(Task { () -> String? in
        do { return try await actions.resolve(ComposableLaunchRequest(repositoryId: "repo", task: "Task")).digest } catch { return nil }
      })
      #expect(await stale.value == nil)
      #expect(f.a.requests.count == 1 && f.b.requests.isEmpty)
      #expect(actions.connectionID != store.actions { _ in }.connectionID)
    }
  }
}

private func followUpBody(_ request: URLRequest) -> Data? {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return nil }
  stream.open(); defer { stream.close() }
  var data = Data(); var buffer = [UInt8](repeating: 0, count: 2048)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    guard count > 0 else { break }; data.append(buffer, count: count)
  }
  return data
}
