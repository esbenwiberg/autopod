import Foundation
import Testing
@testable import AutopodUI
@testable import AutopodDesktop

@Suite(.serialized) @MainActor
struct DecisionReplySurfaceTests {
  @Test func retainedControlsCannotRetargetNewDecisionBeforeRender() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let actions = handler.actions.decisionReply
      let old = DecisionReplyInteraction(context: .init(handlerID: actions.contextID, podID: "decision", decisionID: "A"), actions: actions)
      old.edit("draft A")
      f.store.setEscalation("decision", question: "Question B?", id: "B")
      actions.edit("decision", "B", "draft B")
      // Invoke the exact immutable interaction used by old TextField/option/Cancel closures,
      // without allowing a SwiftUI update to replace the rendered controls.
      old.edit("late typing")
      old.discard()
      #expect(await f.track(old.submit(selected: "approved")).value == .notAdmitted)
      #expect(actions.snapshot("decision", "B").text == "draft B")
      #expect(f.a.requests.isEmpty)
    }
  }

  @Test(arguments: ["decision", "generation", "removal", "unmount", "same-context-remount"])
  func liveCompletionAuthorityDoesNotDependOnRender(kind: String) async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod("A"))
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let actions = handler.actions.decisionReply
      let captured = DecisionReplyContext(handlerID: actions.contextID, podID: "decision", decisionID: "A")
      let surface = DecisionReplySurface()
      surface.mount(captured)
      let lease = surface.lease
      actions.edit("decision", "A", "text")
      let record = actions.snapshot("decision", "A").recordID
      #expect(surface.canDismiss(captured, lease: lease, actions: actions, record: record))
      if kind == "decision" { f.store.setEscalation("decision", question: "B", id: "B") }
      if kind == "generation" { f.store.configure(api: f.apiA) }
      if kind == "removal" {
        f.store.removeSession("decision"); f.store.upsertSession(try decisionPod("A"))
        actions.edit("decision", "A", "new record")
      }
      if kind == "unmount" { surface.unmount() }
      if kind == "same-context-remount" { surface.unmount(); surface.mount(captured) }
      // Deliberately don't update surface.context after underlying store changes.
      #expect(!surface.canDismiss(captured, lease: lease, actions: actions, record: record))
    }
  }

  @Test func queuedPreparationCannotResurrectOldMountAndLateCompletionCannotReplaceNewerResult() async throws {
    try await withPodStoreLifetimeFixture { f in
      f.store.upsertSession(try decisionPod(nil))
      let handler = ActionHandler(api: f.apiA, podStore: f.store, profileStore: ProfileStore())
      let actions = handler.actions.decisionReply
      let old = DecisionReplyContext(handlerID: actions.contextID, podID: "decision", decisionID: nil)
      let current = DecisionReplyContext(handlerID: UUID(), podID: "decision", decisionID: nil)
      let surface = DecisionReplySurface()
      surface.mount(old)
      let queued = f.track(surface.prepareTask(old, actions: actions))
      surface.unmount(); surface.mount(current)
      await queued.value
      #expect(surface.context == current && !surface.loading)
      #expect(f.a.requests.isEmpty)
      surface.mount(old)
      let sameContextQueued = f.track(surface.prepareTask(old, actions: actions))
      surface.unmount(); surface.mount(old)
      await sameContextQueued.value
      #expect(surface.context == old && !surface.loading && f.a.requests.isEmpty)
      let first = f.track(surface.prepareTask(old, actions: actions))
      let firstGet = try await f.next(f.a, "/pods/decision")
      let second = f.track(surface.prepareTask(old, actions: actions))
      let secondGet = try await f.next(f.a, "/pods/decision")
      secondGet.respond(status: 500, body: "{}")
      await second.value
      let error = surface.error
      #expect(error != nil)
      firstGet.respond(body: try decisionSnapshot("A"))
      await first.value
      #expect(surface.error == error && !surface.loading)
      surface.unmount()
      let cancelled = f.track(surface.prepareTask(old, actions: actions))
      cancelled.cancel()
      await cancelled.value
      #expect(surface.context == nil && f.a.requests.count == 2)
    }
  }
}
