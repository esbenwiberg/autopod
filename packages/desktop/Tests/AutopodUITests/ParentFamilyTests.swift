import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@Test func parentFamilyChildPresentationDistinguishesEveryDaemonState() throws {
  let family = try decodeFamily(children: [
    ("reserve", nil, "reserved"),
    ("start", "child-start", "started"),
    ("exit", "child-exit", "exited"),
    ("future", "child-future", "future-status"),
  ])

  let presentations = family.children.map(ParentManagedChildPresentation.init)
  #expect(presentations.map(\.title) == ["Reserved", "Started", "Exited", "Unknown"])
  #expect(presentations.map(\.tone) == [.reserved, .started, .exited, .unknown])
  #expect(family.children.map(\.child) == [nil, "child-start", "child-exit", "child-future"])
}

@Test(arguments: ["provider-request-limit", "future-reason"]) func parentFamilyExplainsOnlyKnownRequestStops(reason: String) throws {
  let data = Data("""
    {"requestKey":"work","parentAttempt":"attempt","child":"child","status":"exited","exitReason":"\(reason)"}
    """.utf8)
  let child = try JSONDecoder().decode(ParentManagedChild.self, from: data)
  let view = ParentManagedChildPresentation(child)
  #expect(view.title == "Exited")
  #expect(view.tone == (reason == "provider-request-limit" ? .limited : .exited))
  #expect(view.detail == (reason == "provider-request-limit"
    ? "Child used all allowed model requests before finishing." : "Child task exited"))
}

@Test(arguments: ["pending", "collected", "unavailable", "future"]) func parentFamilySeparatesExitFromCommitCollection(status: String) throws {
  let json = """
    {"requestKey":"work","parentAttempt":"a","child":"child","status":"exited","exitCode":0,"collectionStatus":"\(status)"}
    """
  let presentation = ParentManagedChildPresentation(try JSONDecoder().decode(ParentManagedChild.self, from: Data(json.utf8)))
  #expect(presentation.title == "Exited")
  #expect(presentation.detail == "Exit code 0")
  #expect(presentation.collection == [
    "pending": "Collecting commit",
    "collected": "Commit collected",
    "unavailable": "No commit collected",
  ][status])
  let withoutExit = json.replacingOccurrences(of: "\"exited\"", with: "\"started\"")
  #expect(ParentManagedChildPresentation(try JSONDecoder().decode(ParentManagedChild.self, from: Data(withoutExit.utf8))).collection == nil)
}

@Test func parentReviewShowsReadyEvidenceOnlyWhileCurrentAndWellFormed() throws {
  let commit = String(repeating: "a", count: 40)
  let evidence = "sha256:" + String(repeating: "b", count: 64)
  let family = try decodeFamily(children: [], review: [
    "status": "ready", "evidenceDigest": evidence, "commit": commit,
  ])
  let review = try #require(family.review)
  let ready = ParentReviewPresentation(review, isStale: false)
  #expect(ready.title == "Tested change ready for review")
  #expect(ready.commit == commit)
  #expect(ready.evidence == evidence)

  let stale = ParentReviewPresentation(review, isStale: true)
  #expect(stale.title == "Review status not current")
  #expect(stale.evidence == nil)
  let malformed = try decodeFamily(children: [], review: ["status": "ready", "evidenceDigest": evidence])
  #expect(ParentReviewPresentation(try #require(malformed.review), isStale: false).title == "Review unavailable")
}

@Test(arguments: [
  ["not-sent", "Evaluation not sent"],
  ["unknown", "Evaluation outcome unknown"],
  ["candidate-unavailable", "Coding result unavailable"],
  ["future-status", "Review unavailable"],
]) func parentReviewDistinguishesStoppedAndUnsupportedStates(testCase: [String]) throws {
  let family = try decodeFamily(children: [], review: ["status": testCase[0]])
  let view = ParentReviewPresentation(try #require(family.review), isStale: false)
  #expect(view.title == testCase[1])
  #expect(view.evidence == nil)
}

@MainActor @Test func parentFamilyScopeIsIndependentOfParentLifecycle() {
  let connectionID = UUID()
  // The same task can be inspected both while it runs and after it exits.
  #expect(ParentFamilyModel.scope(parent: "parent", isWorkspace: false, connectionID: connectionID)
    == ParentFamilyScope(connectionID: connectionID, parent: "parent"))
  #expect(ParentFamilyModel.scope(parent: "parent", isWorkspace: true, connectionID: connectionID) == nil)
  #expect(ParentFamilyModel.scope(parent: "parent", isWorkspace: false, connectionID: nil) == nil)
}

@MainActor @Test func parentFamilyDefaultsHideUnsupportedOrUnauthorizedDaemons() async throws {
  let actions = PodActions()
  #expect(actions.parentFamilyConnectionID == nil)
  let unsupportedFamily = try await actions.loadParentFamily("parent")
  #expect(unsupportedFamily == nil)

  let model = ParentFamilyModel()
  await model.load(parent: "parent", connectionID: UUID()) { _ in nil }
  #expect(model.family == nil)
  #expect(model.isStale == false)
}

@MainActor @Test func parentFamilyObserveBoundsDiscoveryAndPollsKnownFamilies() async throws {
  let model = ParentFamilyModel()
  let scope = ParentFamilyScope(connectionID: UUID(), parent: "parent")
  var loads = 0
  await model.observe(scope, using: { _ in
    loads += 1
    return nil // old daemon or non-family
  }, pause: {})
  #expect(model.family == nil)
  #expect(loads == 3)

  // This is the production .task identity: phase changes trigger another discovery.
  #expect(ParentFamilyModel.loadKey(for: scope, status: .queued)
    != ParentFamilyModel.loadKey(for: scope, status: .running))
  let reserved = try decodeFamily(children: [])
  let started = try decodeFamily(children: [("first", "child", "started")])
  var pauses = 0
  await model.observe(scope, using: { _ in
    loads += 1
    return loads == 4 ? reserved : started
  }, pause: {
    pauses += 1
    if pauses == 1 {
      #expect(model.family == reserved)
    } else {
      throw CancellationError()
    }
  })
  #expect(model.family == started)
  #expect(loads == 5)
}

@MainActor @Test(arguments: [false, true]) func parentFamilyRecoversInitialAbsenceOrFailureWithoutLifecycleChange(transient: Bool) async throws {
  let model = ParentFamilyModel()
  let scope = ParentFamilyScope(connectionID: UUID(), parent: "parent")
  let available = try decodeFamily(children: [("late", "child", "started")])
  var loads = 0
  await model.observe(scope, using: { _ in
    loads += 1
    if loads == 1 {
      if transient { throw URLError(.timedOut) }
      return nil
    }
    // Revoke on the next poll. No further discovery may retain the old rows.
    return loads == 2 ? available : nil
  }, pause: {
    if loads == 2 { #expect(model.family == available) }
  })
  #expect(loads == 3)
  #expect(model.family == nil)
  #expect(model.lastError == nil)
}

@MainActor @Test func parentFamilyMayBeKnownBeforeAnyChildIsAdmitted() async throws {
  let model = ParentFamilyModel()
  let connectionID = UUID()
  let empty = try decodeFamily(children: [])
  let started = try decodeFamily(children: [("first", "child", "started")])
  await model.load(parent: "parent", connectionID: connectionID) { _ in empty }
  #expect(model.family == empty)
  await model.load(parent: "parent", connectionID: connectionID) { _ in started }
  #expect(model.family == started)
}

@MainActor @Test func parentFamilyClearsPreviouslyVisibleRowsWhenNoLongerAvailable() async throws {
  let model = ParentFamilyModel()
  let connectionID = UUID()
  let family = try decodeFamily(children: [("live", "child", "started")])
  await model.load(parent: "parent", connectionID: connectionID) { _ in family }
  #expect(model.family == family)
  await model.load(parent: "parent", connectionID: connectionID) { _ in nil }
  #expect(model.family == nil)
  #expect(!model.isStale)
}

@MainActor @Test func parentFamilyKeepsKnownDataAndMarksItStaleAfterTransientFailure() async throws {
  let model = ParentFamilyModel()
  let connectionID = UUID()
  let known = try decodeFamily(children: [("start", "child", "started")], run: "run-known")

  await model.load(parent: "parent", connectionID: connectionID) { _ in known }
  await model.load(parent: "parent", connectionID: connectionID) { _ in
    throw URLError(.timedOut)
  }

  #expect(model.family == known)
  #expect(model.isStale)
  #expect(model.lastError != nil)
}

@MainActor @Test func parentFamilyRestoresReadyChangeOnlyAfterFreshReconnectResponse() async throws {
  let model = ParentFamilyModel()
  let old = ParentFamilyScope(connectionID: UUID(), parent: "parent")
  let new = ParentFamilyScope(connectionID: UUID(), parent: "parent")
  let commit = String(repeating: "a", count: 40)
  let evidence = "sha256:" + String(repeating: "b", count: 64)
  let ready = try decodeFamily(
    children: [("left", "child-1", "exited"), ("right", "child-2", "exited")],
    review: ["status": "ready", "commit": commit, "evidenceDigest": evidence]
  )
  await model.load(parent: old.parent, connectionID: old.connectionID) { _ in ready }
  #expect(model.family(for: old) == ready)

  await model.load(parent: new.parent, connectionID: new.connectionID) { _ in
    #expect(model.family(for: old) == nil)
    #expect(model.family(for: new) == nil)
    return ready
  }

  let restored = try #require(model.family(for: new))
  #expect(restored == ready)
  let presentation = ParentReviewPresentation(try #require(restored.review), isStale: model.isStale)
  #expect(presentation.title == "Tested change ready for review")
  #expect(presentation.commit == commit)
  #expect(presentation.evidence == evidence)
}

@MainActor @Test func parentFamilyRejectsLateResponsesAfterReconnect() async throws {
  let model = ParentFamilyModel()
  let pending = PendingFamilyLoad()
  let oldConnection = UUID()
  let newConnection = UUID()
  let oldFamily = try decodeFamily(
    children: [("old", "old-child", "exited")],
    run: "old-run",
    review: ["status": "ready"]
  )
  let newFamily = try decodeFamily(children: [("new", "new-child", "started")], run: "new-run")

  let oldTask = Task {
    await model.load(parent: "parent", connectionID: oldConnection) { id in
      try await pending.load(id)
    }
  }
  while !pending.hasContinuation { await Task.yield() }

  await model.load(parent: "parent", connectionID: newConnection) { _ in newFamily }
  pending.resume(returning: oldFamily)
  await oldTask.value

  let newScope = ParentFamilyScope(connectionID: newConnection, parent: "parent")
  #expect(model.family(for: newScope) == newFamily)
  #expect(model.family?.run == "new-run")
  #expect(model.family?.review == nil)
}

@MainActor @Test func parentFamilyRejectsLateResponsesAfterParentSelectionChanges() async throws {
  let model = ParentFamilyModel()
  let pending = PendingFamilyLoad()
  let connectionID = UUID()
  let oldFamily = try decodeFamily(
    children: [("old", "old-child", "exited")],
    run: "old-run",
    parent: "old-parent"
  )
  let newFamily = try decodeFamily(
    children: [("new", "new-child", "started")],
    run: "new-run",
    parent: "new-parent"
  )

  let oldTask = Task {
    await model.load(parent: "old-parent", connectionID: connectionID) { id in
      try await pending.load(id)
    }
  }
  while !pending.hasContinuation { await Task.yield() }

  await model.load(parent: "new-parent", connectionID: connectionID) { _ in newFamily }
  pending.resume(returning: oldFamily)
  await oldTask.value

  let newScope = ParentFamilyScope(connectionID: connectionID, parent: "new-parent")
  #expect(model.family(for: newScope) == newFamily)
  #expect(model.family?.parent == "new-parent")
}

@MainActor
private final class PendingFamilyLoad {
  private var continuation: CheckedContinuation<ParentManagedFamily?, any Error>?
  var hasContinuation: Bool { continuation != nil }

  func load(_: String) async throws -> ParentManagedFamily? {
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
    }
  }

  func resume(returning family: ParentManagedFamily?) {
    continuation?.resume(returning: family)
    continuation = nil
  }
}

private func decodeFamily(
  children: [(requestKey: String, child: String?, status: String)],
  run: String = "run-1",
  parent: String = "parent",
  review: [String: String]? = nil
) throws -> ParentManagedFamily {
  let childObjects = children.map { child in
    [
      "requestKey": child.requestKey,
      "parentAttempt": "attempt-1",
      "child": child.child.map { $0 as Any } ?? NSNull(),
      "status": child.status,
    ] as [String: Any]
  }
  var object: [String: Any] = ["parent": parent, "run": run, "children": childObjects]
  if let review { object["review"] = review }
  let data = try JSONSerialization.data(withJSONObject: object)
  return try JSONDecoder().decode(ParentManagedFamily.self, from: data)
}
