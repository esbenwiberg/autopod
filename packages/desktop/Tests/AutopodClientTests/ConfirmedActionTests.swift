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
    let task = Task { await action.call(handler.actions, id: id) }
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

// Each ephemeral session routes only to its registered synthetic peer. No shared
// mutable handler, network fallback, credential store, or production bootstrap.
private final class ConfirmedActionRegistry: @unchecked Sendable {
  static let shared = ConfirmedActionRegistry()
  private let lock = NSLock()
  private var peers: [String: ConfirmedActionPeer] = [:]
  func add(_ peer: ConfirmedActionPeer) { lock.withLock { peers[peer.host] = peer } }
  func remove(_ peer: ConfirmedActionPeer) { _ = lock.withLock { peers.removeValue(forKey: peer.host) } }
  func peer(_ host: String) -> ConfirmedActionPeer? { lock.withLock { peers[host] } }
}

// The protocol object stays behind its lifecycle lock. Only this immutable
// response handle crosses the async request barrier.
struct ConfirmedActionRequest: @unchecked Sendable {
  fileprivate let transport: ConfirmedActionProtocol
  var request: URLRequest { transport.request }
  func respond(status: Int = 200, body: String) { transport.respond(status: status, body: body) }
  func fail(_ error: URLError) { transport.fail(error) }
}

final class ConfirmedActionPeer: @unchecked Sendable {
  let host = "action-\(UUID().uuidString.lowercased()).invalid"
  private let lock = NSLock()
  private let stream: AsyncStream<ConfirmedActionRequest>
  private let continuation: AsyncStream<ConfirmedActionRequest>.Continuation
  private var active: [ObjectIdentifier: ConfirmedActionProtocol] = [:]
  private var recorded: [URLRequest] = []
  private var closed = false
  private var expired = 0
  var requests: [URLRequest] { lock.withLock { recorded } }
  var activeCount: Int { lock.withLock { active.count } }
  var deadlines: Int { lock.withLock { expired } }

  init() { (stream, continuation) = AsyncStream.makeStream() }
  func receive(_ request: ConfirmedActionProtocol) {
    let accepted = lock.withLock {
      recorded.append(request.request)
      guard !closed else { return false }
      active[ObjectIdentifier(request)] = request
      return true
    }
    if accepted { continuation.yield(ConfirmedActionRequest(transport: request)) }
    else { request.fail(URLError(.cancelled)) }
  }
  func finished(_ request: ConfirmedActionProtocol, expired: Bool = false) {
    lock.withLock {
      active.removeValue(forKey: ObjectIdentifier(request))
      if expired { self.expired += 1 }
    }
  }
  func next() async throws -> ConfirmedActionRequest {
    try await withThrowingTaskGroup(of: ConfirmedActionRequest.self) { group in
      group.addTask { [stream] in
        for await request in stream { return request }
        throw URLError(.cancelled)
      }
      group.addTask {
        try await Task.sleep(for: .seconds(5))
        throw URLError(.timedOut)
      }
      defer { group.cancelAll() }
      return try await group.next()!
    }
  }
  func close() {
    let pending = lock.withLock { closed = true; return Array(active.values) }
    continuation.finish()
    pending.forEach { $0.fail(URLError(.cancelled)) }
  }
}

final class ConfirmedActionProtocol: URLProtocol, @unchecked Sendable {
  private let lock = NSRecursiveLock()
  private var finished = false
  private var peer: ConfirmedActionPeer?
  private var deadline: DispatchWorkItem?
  // Intercept every request in this private session: unexpected hosts fail closed.
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    lock.withLock {
      guard !finished else { return }
      guard let host = request.url?.host, let peer = ConfirmedActionRegistry.shared.peer(host) else {
        fail(URLError(.unsupportedURL)); return
      }
      self.peer = peer
      let timer = DispatchWorkItem { [weak self] in self?.fail(URLError(.timedOut), expired: true) }
      deadline = timer
      DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timer)
      peer.receive(self)
    }
  }
  func respond(status: Int = 200, body: String) {
    finish {
      let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
  }
  func fail(_ error: URLError, expired: Bool = false) {
    finish(expired: expired) { client?.urlProtocol(self, didFailWithError: error) }
  }
  private func finish(expired: Bool = false, _ callback: () -> Void) {
    lock.withLock {
      guard !finished else { return }
      finished = true
      deadline?.cancel(); deadline = nil
      peer?.finished(self, expired: expired)
      callback()
    }
  }
  override func stopLoading() { finish {} }
}
