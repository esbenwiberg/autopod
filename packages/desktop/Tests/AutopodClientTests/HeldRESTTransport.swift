import Foundation

// Each ephemeral session routes only to its registered synthetic peer. No shared
// mutable handler, network fallback, credential store, or production bootstrap.
final class ConfirmedActionRegistry: @unchecked Sendable {
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
