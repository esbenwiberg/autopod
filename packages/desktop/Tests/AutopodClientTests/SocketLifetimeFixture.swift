import Foundation
import Network
import Testing
@testable import AutopodClient

// A per-test recorder. Every waiter unregisters on success, timeout, or cancellation.
final class SocketLifetimeLog: @unchecked Sendable {
  private let lock = NSLock()
  private var entries: [String] = []
  private var observers: [UUID: AsyncStream<[String]>.Continuation] = [:]
  var values: [String] { lock.withLock { entries } }

  func add(_ entry: String) {
    lock.withLock {
      entries.append(entry)
      for observer in observers.values { observer.yield(entries) }
    }
  }

  func wait(_ label: String, until predicate: @escaping @Sendable ([String]) -> Bool) async throws {
    let id = UUID()
    let (stream, continuation) = AsyncStream<[String]>.makeStream()
    continuation.onTermination = { [weak self] _ in
      guard let self else { return }
      _ = self.lock.withLock { self.observers.removeValue(forKey: id) }
    }
    lock.withLock { observers[id] = continuation; continuation.yield(entries) }
    defer { continuation.finish() }
    try await withThrowingTaskGroup(of: Void.self) { group in
      group.addTask {
        for await values in stream {
          if predicate(values) { return }
        }
        throw CancellationError()
      }
      group.addTask {
        try await Task.sleep(for: .seconds(5))
        throw SocketLifetimeFailure.deadline(label)
      }
      defer { group.cancelAll() }
      try await group.next()
    }
  }

  func waitFor(_ entry: String) async throws {
    try await wait(entry) { $0.contains(entry) }
  }
}

enum SocketLifetimeFailure: Error { case deadline(String), missingPeer }

// Intentionally ignores task cancellation, like an asynchronous token provider
// which cannot cancel its underlying operation. Fixture teardown always releases it.
final class SocketTokenGate: @unchecked Sendable {
  let log = SocketLifetimeLog()
  private let lock = NSLock()
  private var open = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var calls = 0

  func token() async -> String {
    let first = lock.withLock { calls += 1; return calls == 1 }
    if first {
      await withCheckedContinuation { continuation in
        lock.withLock {
          if open { continuation.resume() }
          else { waiters.append(continuation) }
        }
        log.add("entered")
      }
      log.add("returned")
    }
    return "synthetic-socket-token"
  }

  func release() {
    let pending = lock.withLock { open = true; let pending = waiters; waiters = []; return pending }
    pending.forEach { $0.resume() }
  }
}

// All Network objects and mutable peer state are confined to this serial queue.
// Only immutable messages enter the lock-protected recorder used by async tests.
final class NativeSocketPeer: @unchecked Sendable {
  let log = SocketLifetimeLog()
  private let queue = DispatchQueue(label: "autopod.socket-lifetime-peer")
  private let listener: NWListener
  private var peers: [Int: NWConnection] = [:]
  private var nextID = 0
  private var stopping = false

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let websocket = NWProtocolWebSocket.Options()
    websocket.autoReplyPing = true
    websocket.setClientRequestHandler(queue) { _, _ in .init(status: .accept, subprotocol: nil) }
    parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
    listener = try NWListener(using: parameters)
    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready: log.add("ready")
      case .cancelled: log.add("listener-cancelled")
      case .failed: log.add("listener-failed"); listener.cancel()
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { connection.cancel(); return }
      nextID += 1
      let id = nextID
      peers[id] = connection
      log.add("accepted:\(id)")
      connection.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .cancelled: peers.removeValue(forKey: id); log.add("cancelled:\(id)")
        case .failed: connection.cancel()
        default: break
        }
      }
      connection.start(queue: queue)
      if stopping { connection.cancel() }
      else { receive(connection, id: id) }
    }
  }

  func start() async throws -> URL {
    listener.start(queue: queue)
    try await log.waitFor("ready")
    return URL(string: "http://127.0.0.1:\(listener.port!.rawValue)")!
  }

  private func receive(_ connection: NWConnection, id: Int) {
    connection.receiveMessage { [weak self] data, context, _, error in
      guard let self else { connection.cancel(); return }
      let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
      if metadata?.opcode == .close {
        log.add("closed:\(id)")
        connection.cancel()
        return
      }
      if error != nil { connection.cancel(); return }
      if let data, let text = String(data: data, encoding: .utf8) {
        log.add("frame:\(id):\(text)")
      }
      guard !stopping else { connection.cancel(); return }
      receive(connection, id: id)
    }
  }

  func subscribed(_ id: Int) async throws {
    try await log.wait("subscribe_all on peer \(id)") { values in
      values.contains { $0.hasPrefix("frame:\(id):") && $0.contains("subscribe_all") }
    }
  }

  func send(_ text: String, to id: Int) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async { [self] in
        guard let peer = peers[id], !stopping else {
          continuation.resume(throwing: SocketLifetimeFailure.missingPeer); return
        }
        let context = NWConnection.ContentContext(identifier: "fixture-text", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        peer.send(content: Data(text.utf8), contentContext: context, completion: .contentProcessed { error in
          if let error { continuation.resume(throwing: error) }
          else { continuation.resume() }
        })
      }
    }
  }

  func drop(_ id: Int) async {
    await withCheckedContinuation { continuation in
      queue.async { [self] in peers[id]?.cancel(); continuation.resume() }
    }
  }

  func dispose() async throws {
    await withCheckedContinuation { continuation in
      queue.async { [self] in
        stopping = true
        for peer in peers.values { peer.cancel() }
        listener.cancel()
        continuation.resume()
      }
    }
    try await log.wait("all native resources cancelled") { values in
      values.contains("listener-cancelled") &&
        values.filter { $0.hasPrefix("accepted:") }.count == values.filter { $0.hasPrefix("cancelled:") }.count
    }
    #expect(!log.values.contains("listener-failed"))
  }
}

private final class SocketSessionDelegate: NSObject, URLSessionDelegate, Sendable {
  let log = SocketLifetimeLog()
  func urlSession(_ session: URLSession, didBecomeInvalidWithError error: (any Error)?) {
    log.add("invalidated")
  }
}

@MainActor final class SocketLifetimeFixture {
  let peer: NativeSocketPeer
  let callbacks = SocketLifetimeLog()
  let gate = SocketTokenGate()
  let session: URLSession
  private let delegate = SocketSessionDelegate()
  private var sockets: [EventSocket] = []
  private(set) var url: URL!

  init() throws {
    peer = try NativeSocketPeer()
    session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
  }

  func start() async throws { url = try await peer.start() }

  func socket(heldToken: Bool = false) -> EventSocket {
    let gate = gate
    let provider: DaemonAccessTokenProvider? = heldToken ? { @Sendable in await gate.token() } : nil
    let callbacks = callbacks
    let socket = EventSocket(baseURL: url, token: "synthetic-socket-token", tokenProvider: provider,
      session: session, onEvent: { callbacks.add("event:\($0._eventId ?? -1)") },
      onStateChange: { callbacks.add("state:\($0)") }, onResyncRequired: { callbacks.add("resync") })
    sockets.append(socket)
    return socket
  }

  func dispose() async throws {
    gate.release()
    for socket in sockets { await socket.disconnect() }
    session.invalidateAndCancel()
    // Cancel peer/listener even if the session invalidation barrier fails.
    do { try await delegate.log.waitFor("invalidated") }
    catch { try await peer.dispose(); throw error }
    try await peer.dispose()
    print("SOCKET_TEARDOWN accepted=\(peer.log.values.filter { $0.hasPrefix("accepted:") }.count) cancelled=\(peer.log.values.filter { $0.hasPrefix("cancelled:") }.count) session=invalidated listener=cancelled")
  }
}

@MainActor func withSocketLifetimeFixture(_ body: (SocketLifetimeFixture) async throws -> Void) async throws {
  let fixture = try SocketLifetimeFixture()
  do {
    try await fixture.start()
    try await body(fixture)
    try await fixture.dispose()
  } catch {
    try await fixture.dispose()
    throw error
  }
}
