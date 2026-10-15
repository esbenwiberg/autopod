import Foundation
import Testing
import AutopodClient
import AutopodDesktop
import AutopodUI

@MainActor final class PodStoreLifetimeFixture {
  let store = PodStore()
  let a = ConfirmedActionPeer()
  let b = ConfirmedActionPeer()
  let apiA: DaemonAPI
  let apiB: DaemonAPI
  private var sessions: [URLSession]
  private var tasks: [Task<String?, Never>] = []

  init() {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ConfirmedActionProtocol.self]
    let sessionA = URLSession(configuration: config)
    let sessionB = URLSession(configuration: config)
    sessions = [sessionA, sessionB]
    apiA = DaemonAPI(baseURL: URL(string: "https://\(a.host)")!, token: "synthetic", session: sessionA)
    apiB = DaemonAPI(baseURL: URL(string: "https://\(b.host)")!, token: "synthetic", session: sessionB)
    ConfirmedActionRegistry.shared.add(a)
    ConfirmedActionRegistry.shared.add(b)
    store.configure(api: apiA)
  }

  func additionalAPI(for peer: ConfirmedActionPeer,
    tokenProvider: DaemonAccessTokenProvider? = nil) -> DaemonAPI {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ConfirmedActionProtocol.self]
    let session = URLSession(configuration: config)
    sessions.append(session)
    let url = URL(string: "https://\(peer.host)")!
    if let tokenProvider {
      return DaemonAPI(baseURL: url, initialToken: "synthetic", session: session, tokenProvider: tokenProvider)
    }
    return DaemonAPI(baseURL: url, token: "synthetic", session: session)
  }

  func start(_ operation: @escaping @MainActor () async -> Void) -> Task<String?, Never> {
    startResult { await operation(); return nil }
  }
  func startResult(_ operation: @escaping @MainActor () async -> String?) -> Task<String?, Never> {
    let task = Task { await operation() }
    tasks.append(task)
    return task
  }
  func next(_ peer: ConfirmedActionPeer, _ path: String) async throws -> ConfirmedActionRequest {
    let request = try await peer.next()
    try #require(request.request.httpMethod == "GET")
    try #require(request.request.url?.path == path)
    return request
  }
  func seed(_ id: String, task: String = "B detail") {
    var pod = Pod(id: id, status: .running, branch: "B/branch", profileName: "fixture",
      model: "fixture", startedAt: .distantPast, updatedAt: .distantPast)
    pod.task = task
    store.upsertSession(pod)
  }
  func finishList(_ peer: ConfirmedActionPeer, task: Task<String?, Never>, id: String) async throws {
    try await next(peer, "/pods").respond(body: lifetimePage(id: id, hasNext: false))
    try await next(peer, "/pods/scores").respond(body: "[]")
    _ = await task.value
  }
  func dispose() async {
    a.close(); b.close()
    tasks.forEach { $0.cancel() }
    sessions.forEach { $0.invalidateAndCancel() }
    for task in tasks { _ = await task.value }
    ConfirmedActionRegistry.shared.remove(a)
    ConfirmedActionRegistry.shared.remove(b)
    #expect(a.activeCount == 0 && b.activeCount == 0)
    #expect(a.deadlines == 0 && b.deadlines == 0)
  }
}

@MainActor func withPodStoreLifetimeFixture(
  _ body: (PodStoreLifetimeFixture) async throws -> Void
) async throws {
  let fixture = PodStoreLifetimeFixture()
  do { try await body(fixture); await fixture.dispose() }
  catch { await fixture.dispose(); throw error }
}

func lifetimeDiff(_ path: String?) -> String {
  let files = path.map { "[{\"path\":\"\($0)\",\"status\":\"modified\",\"diff\":\"synthetic\"}]" } ?? "[]"
  return "{\"files\":\(files),\"stats\":{\"added\":1,\"removed\":0,\"changed\":1}}"
}
func lifetimeSeries(_ name: String) -> String {
  "{\"seriesId\":\"series\",\"seriesName\":\"\(name)\",\"pods\":[\(lifetimePod(id: name))],\"statusCounts\":{\"complete\":1}}"
}
func lifetimeScores(_ id: String) -> String {
  """
  [{"podId":"\(id)","score":80,"algorithmVersion":1,"inspectionAvailability":"available",
  "editCount":1,"userInterrupts":0,"editChurnCount":0,"tellsCount":0,"prFixAttempts":0,
  "inputTokens":0,"outputTokens":0,"costUsd":0,"runtime":"codex","profileName":"fixture",
  "finalStatus":"complete","completedAt":"2026-10-15T00:00:00Z","computedAt":"2026-10-15T00:00:00Z"}]
  """
}

func lifetimePage(
  id: String,
  hasNext: Bool,
  status: String = "complete",
  updatedAt: String = "2026-07-01T00:00:00Z"
) -> String {
  let nextCursor = hasNext ? #""next-page""# : "null"
  return """
  {"pods":[{
    "id":"\(id)","title":"\(id) title","taskExcerpt":"Searchable second line","taskSummary":null,"profileName":"test",
    "status":"\(status)","model":"sonnet","runtime":"claude","executionTarget":"local",
    "branch":"autopod/\(id)","baseBranch":"main","seriesId":null,"seriesName":null,
    "options":{"agentMode":"auto","output":"pr","validationSuite":"full"},
    "hasWebUi":false,"previewUrl":null,"containerId":null,"worktreePath":null,
    "createdAt":"2026-07-01T00:00:00Z","startedAt":null,"runningAt":null,
    "updatedAt":"\(updatedAt)","completedAt":null,"lastHeartbeatAt":null,
    "failureReason":null,"mergeBlockReason":null,"lastCorrectionMessage":null,
    "pendingEscalationSummary":null,"progressSummary":null,
    "inputTokens":1200,"outputTokens":34,"costUsd":1.25,
    "tokenTelemetryAccuracy":"complete","filesChanged":4,"linesAdded":50,"linesRemoved":7
  }],"nextCursor":\(nextCursor)}
  """
}

func lifetimePod(id: String) -> String {
  """
  {
    "id":"\(id)","profileName":"test","task":"Full detail task","status":"complete",
    "model":"sonnet","runtime":"claude","executionTarget":"local","branch":"autopod/\(id)",
    "containerId":null,"worktreePath":null,"validationAttempts":1,"maxValidationAttempts":3,
    "lastValidationResult":null,"pendingEscalation":null,"escalationCount":0,"skipValidation":false,
    "createdAt":"2026-07-01T00:00:00Z","startedAt":"2026-07-01T00:00:01Z",
    "completedAt":"2026-07-01T00:10:00Z","updatedAt":"2026-07-01T00:10:00Z","userId":"user",
    "filesChanged":1,"linesAdded":2,"linesRemoved":0,"previewUrl":null,"prUrl":null,
    "plan":null,"progress":null,"claudeSessionId":null,"outputMode":"pr",
    "options":{"agentMode":"auto","output":"pr","validate":true,"promotable":false},
    "inputTokens":0,"outputTokens":0,"costUsd":0,"tokenTelemetryAccuracy":"complete","commitCount":1
  }
  """
}
