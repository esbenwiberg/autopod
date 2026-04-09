import Foundation

/// Async REST client for the Autopod daemon API.
/// Actor-isolated for thread safety — all methods are safe to call from any context.
public actor DaemonAPI {
  public let baseURL: URL
  public let token: String
  private let session: URLSession
  private let decoder: JSONDecoder
  private let encoder: JSONEncoder

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
    self.session = URLSession.shared
    self.decoder = JSONDecoder()
    self.encoder = JSONEncoder()
  }

  // MARK: - Health

  public func healthCheck() async throws -> Bool {
    let _: HealthResponse = try await request("GET", "/health")
    return true
  }

  public func version() async throws -> String {
    let res: VersionResponse = try await request("GET", "/version")
    return res.version
  }

  // MARK: - Sessions

  public func listSessions(
    profileName: String? = nil,
    status: String? = nil
  ) async throws -> [SessionResponse] {
    var query: [String: String] = [:]
    if let p = profileName { query["profileName"] = p }
    if let s = status { query["status"] = s }
    return try await request("GET", "/sessions", query: query)
  }

  public func getSession(_ id: String) async throws -> SessionResponse {
    try await request("GET", "/sessions/\(id)")
  }

  public func getSessionStats(profileName: String? = nil) async throws -> [String: Int] {
    var query: [String: String] = [:]
    if let p = profileName { query["profile"] = p }
    let res: SessionStatsResponse = try await request("GET", "/sessions/stats", query: query)
    return res.counts
  }

  public func createSession(_ body: CreateSessionRequest) async throws -> SessionResponse {
    try await request("POST", "/sessions", body: try encode(body))
  }

  public func approveSession(_ id: String, squash: Bool? = nil) async throws {
    let body = try squash.map { try encode(ApproveBody(squash: $0)) }
    let _: OkResponse = try await request("POST", "/sessions/\(id)/approve", body: body)
  }

  public func rejectSession(_ id: String, feedback: String? = nil) async throws {
    let body = try feedback.map { try encode(RejectBody(feedback: $0)) }
    let _: OkResponse = try await request("POST", "/sessions/\(id)/reject", body: body)
  }

  public func sendMessage(_ id: String, message: String) async throws {
    let _: OkResponse = try await request(
      "POST", "/sessions/\(id)/message",
      body: try encode(MessageBody(message: message))
    )
  }

  public func nudgeSession(_ id: String, message: String = "Please refocus on the task.") async throws {
    let _: OkResponse = try await request(
      "POST", "/sessions/\(id)/nudge",
      body: try encode(MessageBody(message: message))
    )
  }

  public func killSession(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/sessions/\(id)/kill")
  }

  public func completeSession(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/sessions/\(id)/complete")
  }

  public func triggerValidation(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/sessions/\(id)/validate")
  }

  public func revalidateSession(_ id: String) async throws -> RevalidateResponse {
    try await request("POST", "/sessions/\(id)/revalidate")
  }

  public func fixManually(_ id: String) async throws -> SessionResponse {
    try await request("POST", "/sessions/\(id)/fix-manually")
  }

  public func pauseSession(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/sessions/\(id)/pause")
  }

  public func deleteSession(_ id: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/sessions/\(id)")
  }

  public func approveAllValidated() async throws -> [String] {
    let results: [SessionSummaryResponse] = try await request("POST", "/sessions/approve-all")
    return results.map(\.id)
  }

  public func killAllFailed() async throws -> [String] {
    let results: [SessionSummaryResponse] = try await request("POST", "/sessions/kill-failed")
    return results.map(\.id)
  }

  public func getValidationHistory(_ id: String) async throws -> [ValidationResponse] {
    try await request("GET", "/sessions/\(id)/validations")
  }

  public func getSessionEvents(_ id: String) async throws -> [AgentEventResponse] {
    try await request("GET", "/sessions/\(id)/events")
  }

  public func getSessionDiff(_ id: String) async throws -> DiffApiResponse {
    try await request("GET", "/sessions/\(id)/diff")
  }

  public func getReportToken(_ id: String) async throws -> (token: String?, reportUrl: String) {
    let res: ReportTokenResponse = try await request("GET", "/sessions/\(id)/report/token")
    return (res.token, res.reportUrl)
  }

  // MARK: - Profiles

  public func listProfiles() async throws -> [ProfileResponse] {
    try await request("GET", "/profiles")
  }

  public func getProfile(_ name: String) async throws -> ProfileResponse {
    try await request("GET", "/profiles/\(name)")
  }

  public func createProfile(_ body: ProfileResponse) async throws -> ProfileResponse {
    try await request("POST", "/profiles", body: try encode(body))
  }

  public func updateProfile(_ name: String, body: ProfileResponse) async throws -> ProfileResponse {
    try await request("PUT", "/profiles/\(name)", body: try encode(body))
  }

  /// Partial update — only sends the fields present in the dictionary.
  public func patchProfile(_ name: String, fields: [String: Any]) async throws -> ProfileResponse {
    let body = try JSONSerialization.data(withJSONObject: fields)
    return try await request("PATCH", "/profiles/\(name)", body: body)
  }

  /// Create profile from a raw dictionary.
  public func createProfileFromFields(_ fields: [String: Any]) async throws -> ProfileResponse {
    let body = try JSONSerialization.data(withJSONObject: fields)
    return try await request("POST", "/profiles", body: body)
  }

  public func deleteProfile(_ name: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/profiles/\(name)")
  }

  public func warmProfile(
    _ name: String, rebuild: Bool? = nil, gitPat: String? = nil
  ) async throws -> WarmResult {
    try await request("POST", "/profiles/\(name)/warm", body: try encode(WarmBody(rebuild: rebuild, gitPat: gitPat)))
  }

  // MARK: - History

  public func createHistoryWorkspace(
    profileName: String?,
    limit: Int? = nil,
    since: String? = nil,
    failuresOnly: Bool? = nil
  ) async throws -> SessionResponse {
    try await request(
      "POST", "/sessions/history-workspace",
      body: try encode(
        HistoryWorkspaceBody(
          profileName: profileName,
          limit: limit,
          since: since,
          failuresOnly: failuresOnly
        )
      )
    )
  }

  // MARK: - Actions

  public func fetchActionCatalog() async throws -> [ActionCatalogEntry] {
    try await request("GET", "/actions/catalog")
  }

  // MARK: - Internal request helper

  private func encode(_ value: some Encodable) throws -> Data {
    try encoder.encode(value)
  }

  private func request<T: Decodable>(
    _ method: String,
    _ path: String,
    query: [String: String] = [:],
    body: Data? = nil
  ) async throws -> T {
    var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty {
      components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
    }
    guard let url = components.url else {
      throw DaemonError.networkError("Invalid URL: \(path)")
    }

    var req = URLRequest(url: url)
    req.httpMethod = method
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.timeoutInterval = 30

    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = body
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw DaemonError.networkError(error.localizedDescription)
    }

    guard let http = response as? HTTPURLResponse else {
      throw DaemonError.networkError("Non-HTTP response")
    }

    switch http.statusCode {
    case 200, 201:
      do {
        return try decoder.decode(T.self, from: data)
      } catch {
        throw DaemonError.decodingError("\(error)")
      }
    case 202:
      // Accepted (e.g. shutdown) — try to decode, fall back to empty
      if let result = try? decoder.decode(T.self, from: data) { return result }
      if let empty = EmptyResponse() as? T { return empty }
      throw DaemonError.decodingError("Unexpected 202 response")
    case 204:
      // No content — return empty
      if let empty = EmptyResponse() as? T { return empty }
      throw DaemonError.decodingError("Expected empty response for 204")
    case 401:
      throw DaemonError.unauthorized
    case 404:
      throw DaemonError.notFound(path)
    case 400:
      let msg = String(data: data, encoding: .utf8) ?? "Bad request"
      throw DaemonError.badRequest(msg)
    default:
      let msg = String(data: data, encoding: .utf8) ?? "Unknown error"
      throw DaemonError.serverError(http.statusCode, msg)
    }
  }
}

// MARK: - Internal request/response types

struct OkResponse: Codable {
  let ok: Bool?
}

public struct RevalidateResponse: Codable, Sendable {
  public let newCommits: Bool
  public let result: String
}

struct EmptyResponse: Codable {
  init() {}
  init(from decoder: any Decoder) throws {}
  func encode(to encoder: any Encoder) throws {}
}

struct HealthResponse: Codable {
  let status: String
}

struct VersionResponse: Codable {
  let version: String
}

struct ReportTokenResponse: Codable {
  let token: String?
  let reportUrl: String
}

struct MessageBody: Codable {
  let message: String
}

struct ApproveBody: Codable {
  let squash: Bool?
}

struct RejectBody: Codable {
  let feedback: String?
}

struct WarmBody: Codable {
  let rebuild: Bool?
  let gitPat: String?
}

struct HistoryWorkspaceBody: Codable {
  let profileName: String?
  let limit: Int?
  let since: String?
  let failuresOnly: Bool?
}

