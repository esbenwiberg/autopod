import Foundation
import Testing
import AutopodClient
import AutopodDesktop
import AutopodUI

enum ConfirmedAction: String, CaseIterable, Sendable {
  case pause, kill

  @MainActor func call(_ actions: PodActions, id: String) async {
    switch self {
    case .pause: await actions.pause(id)
    case .kill: await actions.kill(id)
    }
  }
}

@MainActor @Test(arguments: ConfirmedAction.allCases, [false, true])
func confirmedActionRetainsStateOnRejection(action: ConfirmedAction, newerEvent: Bool) async throws {
  try await withConfirmedActionFixture(initial: .awaitingInput) { fixture in
    let task = fixture.start(action)
    let post = try await fixture.next("POST", action: action)
    #expect(fixture.store.selectedSession?.status == .awaitingInput)
    #expect(fixture.handler.pendingAction == "\(action.rawValue)-\(fixture.id)")
    if newerEvent { fixture.store.updateStatus(fixture.id, to: .complete) }
    post.respond(status: 409, body: #"{"error":"Fixture rejected action"}"#)
    await task.value
    fixture.expectState(newerEvent ? .complete : .awaitingInput)
    #expect(fixture.handler.lastError?.contains("Fixture rejected action") == true)
    #expect(fixture.handler.pendingAction == nil)
    #expect(fixture.peer.requests.count == 1)
  }
}

@MainActor @Test(arguments: ConfirmedAction.allCases)
func confirmedActionRetainsStateOnLostResponse(action: ConfirmedAction) async throws {
  try await withConfirmedActionFixture { fixture in
    let task = fixture.start(action)
    let post = try await fixture.next("POST", action: action)
    fixture.expectState(.running)
    post.fail(URLError(.networkConnectionLost))
    await task.value
    fixture.expectState(.running)
    #expect(fixture.handler.lastError != nil)
    #expect(fixture.handler.pendingAction == nil)
    #expect(fixture.peer.requests.count == 1)
  }
}

@MainActor @Test(arguments: ConfirmedAction.allCases, ["confirmed", "refresh-failed", "newer-event"])
func confirmedActionWaitsForObservedState(action: ConfirmedAction, outcome: String) async throws {
  try await withConfirmedActionFixture { fixture in
    let task = fixture.start(action)
    let post = try await fixture.next("POST", action: action)
    fixture.expectState(.running)
    post.respond(body: #"{"ok":true}"#)
    let get = try await fixture.next("GET")
    fixture.expectState(.running)
    #expect(fixture.handler.pendingAction != nil)
    let observed: PodStatus = action == .pause ? .paused : .killing
    if outcome == "newer-event" { fixture.store.updateStatus(fixture.id, to: .killed) }
    if outcome == "refresh-failed" {
      get.respond(status: 503, body: #"{"error":"Fixture snapshot unavailable"}"#)
    } else {
      get.respond(body: fixture.snapshot(status: observed))
    }
    await task.value
    fixture.expectState(outcome == "newer-event" ? .killed : outcome == "refresh-failed" ? .running : observed)
    #expect(fixture.handler.lastError == nil)
    #expect(fixture.handler.pendingAction == nil)
    #expect(fixture.peer.requests.count == 2)
  }
}

@MainActor @Test func confirmedKillAcceptsTerminalSnapshot() async throws {
  try await withConfirmedActionFixture { fixture in
    let task = fixture.start(.kill)
    try await fixture.next("POST", action: .kill).respond(body: #"{"ok":true}"#)
    try await fixture.next("GET").respond(body: fixture.snapshot(status: .killed))
    await task.value
    fixture.expectState(.killed)
    #expect(fixture.handler.pendingAction == nil)
    #expect(fixture.peer.requests.count == 2)
  }
}

@MainActor @Test func confirmedActionFixtureCancelsHeldRequest() async throws {
  try await withConfirmedActionFixture { fixture in
    let task = fixture.start(.kill)
    let post = try await fixture.next("POST", action: .kill)
    await fixture.dispose()
    await task.value
    // A response released after cancellation must not reach URLSession or cause GET.
    post.respond(body: #"{"ok":true}"#)
    fixture.expectState(.running)
    #expect(fixture.handler.pendingAction == nil)
    #expect(fixture.handler.lastError != nil)
    #expect(fixture.peer.requests.count == 1)
  }
}

@MainActor
func withConfirmedActionFixture(
  initial: PodStatus = .running,
  body: (ConfirmedActionFixture) async throws -> Void
) async throws {
  let fixture = ConfirmedActionFixture(initial: initial)
  do {
    try await body(fixture)
    await fixture.dispose()
  } catch {
    await fixture.dispose()
    throw error
  }
}

@MainActor final class ConfirmedActionFixture {
  let id = "observed-pod"
  let peer = ConfirmedActionPeer()
  let store = PodStore()
  let handler: ActionHandler
  private let session: URLSession
  private var tasks: [Task<Void, Never>] = []
  private var disposed = false
  private let startedAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-120))

  init(initial: PodStatus) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ConfirmedActionProtocol.self]
    session = URLSession(configuration: configuration)
    let api = DaemonAPI(baseURL: URL(string: "https://\(peer.host)")!, token: "synthetic-action-token", session: session)
    store.configure(api: api)
    var pod = Pod(id: id, status: initial, branch: "fixture/retained-source", profileName: "isolated-fixture",
      model: "fixture-model", startedAt: ISO8601DateFormatter().date(from: startedAt)!)
    pod.task = "Observe confirmed state during pause and kill."
    pod.updatedAt = Date(timeIntervalSince1970: 0)
    store.upsertSession(pod)
    store.selectedSessionId = id
    handler = ActionHandler(api: api, podStore: store, profileStore: ProfileStore())
    ConfirmedActionRegistry.shared.add(peer)
  }

  func start(_ action: ConfirmedAction) -> Task<Void, Never> {
    start { await action.call(self.handler.actions, id: self.id) }
  }

  func start(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
    let task = Task { await operation() }
    tasks.append(task)
    return task
  }

  func next(_ method: String, action: ConfirmedAction? = nil) async throws -> ConfirmedActionRequest {
    let request = try await peer.next()
    #expect(request.request.httpMethod == method)
    #expect(request.request.url?.path == "/pods/\(id)" + (action.map { "/\($0.rawValue)" } ?? ""))
    #expect(request.request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-action-token")
    return request
  }

  func expectState(_ status: PodStatus) {
    #expect(store.pods.count == 1)
    #expect(store.selectedSession?.id == id)
    #expect(store.selectedSession?.status == status)
    #expect(store.selectedSession?.branch == "fixture/retained-source")
    #expect(store.selectedSession?.profileName == "isolated-fixture")
    #expect(store.selectedSession?.model == "fixture-model")
    #expect(store.selectedSession?.task == "Observe confirmed state during pause and kill.")
  }

  func snapshot(status: PodStatus) -> String {
    """
    {"id":"\(id)","profileName":"isolated-fixture","task":"Observe confirmed state during pause and kill.",
    "status":"\(status.rawValue)","model":"fixture-model","runtime":"codex","executionTarget":"local",
    "branch":"fixture/retained-source","validationAttempts":0,"maxValidationAttempts":3,
    "lastValidationResult":null,"pendingEscalation":null,"escalationCount":0,"skipValidation":false,
    "createdAt":"\(startedAt)","startedAt":"\(startedAt)","updatedAt":"2026-10-15T00:00:00Z",
    "userId":"synthetic","filesChanged":0,"linesAdded":0,"linesRemoved":0,"outputMode":"pr",
    "options":{"agentMode":"auto","output":"pr","validate":true,"promotable":false},
    "inputTokens":0,"outputTokens":0,"costUsd":0,"commitCount":0}
    """
  }

  func dispose() async {
    guard !disposed else { return }
    disposed = true
    peer.close()
    tasks.forEach { $0.cancel() }
    session.invalidateAndCancel()
    for task in tasks { await task.value }
    ConfirmedActionRegistry.shared.remove(peer)
    #expect(peer.activeCount == 0)
    #expect(peer.deadlines == 0)
  }
}
