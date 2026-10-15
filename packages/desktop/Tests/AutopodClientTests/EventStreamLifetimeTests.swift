import Foundation
import Observation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

private actor ControlledEventSocket: EventStreamSocket {
  nonisolated let callbacks: EventStreamSocketCallbacks
  nonisolated let log = SocketLifetimeLog()
  init(_ callbacks: EventStreamSocketCallbacks) { self.callbacks = callbacks }
  func connect() { log.add(Task.isCancelled ? "cancelled-start" : "connect") }
  func disconnect() { log.add("disconnect") }
  func subscribe(podId: String) { log.add("subscribe:\(podId)") }
  func unsubscribe(podId: String) { log.add("unsubscribe:\(podId)") }
}

@MainActor @Suite("EventStream lifetime")
struct EventStreamLifetimeTests {
  @Test func replacementOwnsSocketAndRejectsOldCallbacks() async throws {
    let restLog = SocketLifetimeLog()
    let host = "socket-\(UUID().uuidString.lowercased()).invalid"
    SocketLifetimeRESTProtocol.register(host, log: restLog)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SocketLifetimeRESTProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel(); SocketLifetimeRESTProtocol.unregister(host) }
    let api = DaemonAPI(baseURL: URL(string: "https://\(host)")!, token: "synthetic", session: session)
    let store = PodStore()
    store.configure(api: api)
    store.upsertSession(Pod(id: "socket-fixture", status: .running, branch: "fixture", profileName: "fixture", model: "fixture", startedAt: .now))
    var sockets: [ControlledEventSocket] = []
    let stream = EventStream(podStore: store, socketFactory: { _, _, _, callbacks in
      let socket = ControlledEventSocket(callbacks)
      sockets.append(socket)
      return socket
    })
    defer { stream.disconnect() }
    stream.connect(baseURL: api.baseURL, token: "synthetic", api: api)
    let old = sockets[0]
    try await old.log.waitFor("connect")
    let raw = try JSONDecoder().decode(RawSystemEvent.self, from: Data(
      #"{"type":"pod.validation_started","timestamp":"2026-10-15T00:00:00Z","podId":"socket-fixture","attempt":1}"#.utf8))

    // Queue all old callbacks on MainActor, then replace before yielding to them.
    old.callbacks.event(raw)
    old.callbacks.state(.reconnecting(attempt: 99))
    old.callbacks.resync()
    stream.subscribeToSession("old-subscription")
    stream.unsubscribeFromSession("old-subscription")
    stream.connect(baseURL: api.baseURL, token: "synthetic", api: api)
    let current = sockets[1]
    try await current.log.waitFor("connect")
    // Bounded negative observation of callbacks queued before replacement.
    try await Task.sleep(for: .milliseconds(250))
    #expect(old.log.values.filter { $0 == "disconnect" }.count == 1)
    #expect(!current.log.values.contains("disconnect"))
    #expect(!current.log.values.contains { $0.contains("old-subscription") })
    #expect(stream.connectionState == "Disconnected")
    #expect(store.pods.first?.status == .running)
    #expect(restLog.values.isEmpty)

    // Current callbacks still reach production stream/store; observation is the barrier.
    let changed = SocketLifetimeLog()
    withObservationTracking { _ = store.pods } onChange: { changed.add("pod") }
    current.callbacks.event(raw)
    try await changed.waitFor("pod")
    #expect(store.pods.first?.status == .validating)
    withObservationTracking { _ = stream.connectionState } onChange: { changed.add("state") }
    current.callbacks.state(.connected)
    try await changed.waitFor("state")
    #expect(stream.connectionState == "Connected")
    stream.subscribeToSession("current-subscription")
    try await current.log.waitFor("subscribe:current-subscription")
    stream.unsubscribeFromSession("current-subscription")
    try await current.log.waitFor("unsubscribe:current-subscription")
    stream.disconnect()
    try await current.log.waitFor("disconnect")
  }

  @Test func disconnectBeforeQueuedStart() async throws {
    let store = PodStore()
    var sockets: [ControlledEventSocket] = []
    let stream = EventStream(podStore: store, socketFactory: { _, _, _, callbacks in
      let socket = ControlledEventSocket(callbacks); sockets.append(socket); return socket
    })
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let api = DaemonAPI(baseURL: URL(string: "https://never-used.invalid")!, token: "synthetic", session: session)
    stream.connect(baseURL: api.baseURL, token: "synthetic", api: api)
    stream.disconnect()
    try await Task.sleep(for: .milliseconds(250))
    #expect(!sockets[0].log.values.contains("connect"))
    #expect(sockets[0].log.values.contains("disconnect"))
  }
}

// This private ephemeral session intercepts REST only. Real websocket tests use Network.
private final class SocketLifetimeRESTProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var logs: [String: SocketLifetimeLog] = [:]
  static func register(_ host: String, log: SocketLifetimeLog) { lock.withLock { logs[host] = log } }
  static func unregister(_ host: String) { _ = lock.withLock { logs.removeValue(forKey: host) } }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.lock.withLock { Self.logs[request.url?.host ?? ""] }?.add("request")
    client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
  }
  override func stopLoading() {}
}
