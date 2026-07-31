import Foundation
import Testing
@testable import AutopodClient

private final class PodsitterURLProtocol: URLProtocol, @unchecked Sendable {
  static let lock = NSLock()
  nonisolated(unsafe) static var requests: [URLRequest] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.lock.withLock { Self.requests.append(request) }
    let body: String
    switch request.url?.path {
    case "/podsitter":
      body = Self.statusJSON
    case "/podsitter/config", "/podsitter/enable", "/podsitter/disable":
      body = Self.configurationJSON(enabled: request.url?.path != "/podsitter/disable")
    case "/podsitter/check":
      body = #"{"queued":3,"processed":1}"#
    case "/podsitter/provider/probe":
      body = #"{"recovered":true}"#
    case "/podsitter/decisions":
      body = Self.historyJSON
    default:
      body = "{}"
    }
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: 200,
      httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  static func configurationJSON(enabled: Bool) -> String {
    """
    {
      "enabled":\(enabled),"activation":{"mode":"always"},"authorizedUntil":null,
      "generation":2,"profileScope":null,
      "decisionTarget":{"providerAccountId":"sitter","runtime":"codex","model":"gpt-5"},
      "budgets":{"maxDecisionsPerWindow":20,"maxActionsPerWindow":10},
      "updatedBy":{"type":"human","userId":"masked"},
      "createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"
    }
    """
  }

  static let statusJSON = """
  {
    "configuration":\(configurationJSON(enabled: true)),
    "activation":{"active":false,"windowId":null,"windowStartedAt":null,
      "windowEndsAt":"2026-08-01T03:00:00Z","reason":"outside_window"},
    "provider":{"providerAccountId":"sitter","status":"future_circuit_state",
      "consecutiveFailures":1,"retryAt":"2026-08-01T03:15:00Z","resetAt":null,
      "sanitizedReason":"temporarily limited","probeLeaseOwner":null,"probeLeaseVersion":0,
      "probeLeaseExpiresAt":null,"recoveredAt":null,"updatedAt":"2026-08-01T03:00:00Z"},
    "queueCount":3
  }
  """

  static let historyJSON = """
  {
    "items":[{
      "id":"decision-1","attentionId":"attention-1","podId":"industrial-manatee",
      "attentionSignature":"hash","configurationGeneration":2,"activationWindowId":"window",
      "evidenceHash":"redacted-hash","evidenceVersion":1,
      "target":{"providerAccountId":"sitter","runtime":"codex","model":"gpt-5"},
      "decision":{"contractVersion":1,"attentionSignature":"hash","action":"approve_fact_waiver",
        "arguments":{"factId":"fact-x","credential":"MUST_NOT_DECODE"},
        "reason":"Evidence proves the fact is stale","evidenceRefs":["validation:fact-x"],
        "confidence":"high","remainingRisk":"Manual review remains","stopCondition":"Stop after waiver"},
      "outcome":"completed","failureCode":null,"inputTokens":100,"outputTokens":20,"costUsd":0.01,
      "rawPrompt":"MUST_NOT_DECODE","credentials":"MUST_NOT_DECODE",
      "createdAt":"2026-08-01T02:00:00Z","completedAt":"2026-08-01T02:01:00Z",
      "executedAt":"2026-08-01T02:01:00Z"
    }],"total":1
  }
  """
}

private func requestBodyData(from request: URLRequest) -> Data? {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return nil }
  stream.open()
  defer { stream.close() }
  var data = Data()
  let bufferSize = 4096
  let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
  defer { buffer.deallocate() }
  while stream.hasBytesAvailable {
    let count = stream.read(buffer, maxLength: bufferSize)
    if count <= 0 { break }
    data.append(buffer, count: count)
  }
  return data
}

@Suite(.serialized)
struct PodsitterAPITests {
  private func makeAPI() -> DaemonAPI {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PodsitterURLProtocol.self]
    PodsitterURLProtocol.lock.withLock { PodsitterURLProtocol.requests = [] }
    return DaemonAPI(
      baseURL: URL(string: "https://daemon.example.com")!,
      token: "token",
      session: URLSession(configuration: configuration)
    )
  }

  @Test func decodesStatusWithDistinctAndUnknownStates() async throws {
    let status = try await makeAPI().getPodsitterStatus()
    #expect(status.configuration?.enabled == true)
    #expect(status.activation?.active == false)
    #expect(status.provider?.status == .unknown("future_circuit_state"))
    #expect(status.queueCount == 3)
  }

  @Test func requestsConfigurationAndOperationsFromDaemon() async throws {
    let api = makeAPI()
    let request = PodsitterConfigurationRequest(
      enabled: false,
      activation: .recurring(
        cronExpression: "0 20 * * *",
        durationMinutes: 720,
        timeZone: "Europe/Copenhagen"
      ),
      authorizedUntil: nil,
      profileScope: nil,
      decisionTarget: PodsitterDecisionTargetResponse(
        providerAccountId: "sitter",
        runtime: .codex,
        model: "gpt-5"
      ),
      budgets: PodsitterBudgetsResponse(maxDecisionsPerWindow: 20, maxActionsPerWindow: 10)
    )
    _ = try await api.configurePodsitter(request)
    _ = try await api.enablePodsitter()
    _ = try await api.disablePodsitter()
    #expect(try await api.checkPodsitter().queued == 3)
    #expect(try await api.probePodsitterProvider().recovered)

    let requests = PodsitterURLProtocol.lock.withLock { PodsitterURLProtocol.requests }
    #expect(requests.compactMap { $0.url?.path } == [
      "/podsitter/config", "/podsitter/enable", "/podsitter/disable",
      "/podsitter/check", "/podsitter/provider/probe",
    ])
    let body = try #require(requests.first.flatMap(requestBodyData))
    let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(object["credentials"] == nil)
    #expect(object.keys.contains("authorizedUntil"))
    #expect(object["authorizedUntil"] is NSNull)
    #expect(object.keys.contains("profileScope"))
    #expect(object["profileScope"] is NSNull)
    #expect((object["activation"] as? [String: Any])?["durationMinutes"] as? Int == 720)
  }

  @Test func decisionHistoryExposesOnlyRedactedAuditFields() async throws {
    let response = try await makeAPI().listPodsitterDecisions(limit: 10)
    let decision = try #require(response.items.first?.decision)
    #expect(response.items.first?.podId == "industrial-manatee")
    #expect(decision.action == "approve_fact_waiver")
    #expect(decision.evidenceRefs == ["validation:fact-x"])
    #expect(decision.reason.contains("stale"))
    #expect(decision.remainingRisk == "Manual review remains")

    let mirrorFields = Set(Mirror(reflecting: decision).children.compactMap(\.label))
    #expect(mirrorFields.isDisjoint(with: [
      "arguments", "rawPrompt", "credentials", "logs", "diff",
    ]))
  }
}
