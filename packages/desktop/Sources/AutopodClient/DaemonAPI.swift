import Foundation

/// Async REST client for the Autopod daemon API.
/// Actor-isolated for thread safety — all methods are safe to call from any context.
public actor DaemonAPI {
  public let baseURL: URL
  public let token: String
  private let pod: URLSession
  private let decoder: JSONDecoder
  private let encoder: JSONEncoder

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
    self.pod = URLSession.shared
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

  // MARK: - Pods

  public func listPods(
    profileName: String? = nil,
    status: String? = nil
  ) async throws -> [SessionResponse] {
    var query: [String: String] = [:]
    if let p = profileName { query["profileName"] = p }
    if let s = status { query["status"] = s }
    return try await request("GET", "/pods", query: query)
  }

  public func getPod(_ id: String) async throws -> SessionResponse {
    try await request("GET", "/pods/\(id)")
  }

  public func getSessionStats(profileName: String? = nil) async throws -> [String: Int] {
    var query: [String: String] = [:]
    if let p = profileName { query["profile"] = p }
    let res: SessionStatsResponse = try await request("GET", "/pods/stats", query: query)
    return res.counts
  }

  public func createPod(_ body: CreateSessionRequest) async throws -> SessionResponse {
    try await request("POST", "/pods", body: try encode(body))
  }

  public func approvePod(_ id: String, squash: Bool? = nil) async throws {
    let body = try squash.map { try encode(ApproveBody(squash: $0)) }
    let _: OkResponse = try await request("POST", "/pods/\(id)/approve", body: body)
  }

  public func rejectPod(_ id: String, feedback: String? = nil) async throws {
    let body = try feedback.map { try encode(RejectBody(feedback: $0)) }
    let _: OkResponse = try await request("POST", "/pods/\(id)/reject", body: body)
  }

  public func sendMessage(_ id: String, message: String) async throws {
    let _: OkResponse = try await request(
      "POST", "/pods/\(id)/message",
      body: try encode(MessageBody(message: message))
    )
  }

  public func nudgeSession(_ id: String, message: String = "Please refocus on the task.") async throws {
    let _: OkResponse = try await request(
      "POST", "/pods/\(id)/nudge",
      body: try encode(MessageBody(message: message))
    )
  }

  public func killPod(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/pods/\(id)/kill")
  }

  public func completeSession(
    _ id: String,
    promoteTo: String? = nil,
    instructions: String? = nil
  ) async throws {
    let body: Data?
    if promoteTo != nil || instructions != nil {
      body = try encode(CompleteBody(promoteTo: promoteTo, instructions: instructions))
    } else {
      body = nil
    }
    let _: OkResponse = try await request("POST", "/pods/\(id)/complete", body: body)
  }

  /// Promote an interactive pod to agent-driven (in-place, same pod ID).
  /// `targetOutput` must be one of `pr`, `branch`, `artifact`, `none`. Defaults to `pr` daemon-side.
  /// `instructions` is the human's typed handoff text from the desktop sheet (or CLI flag);
  /// it is composed into a `## Handoff` section in the agent's CLAUDE.md.
  public func promoteSession(
    _ id: String,
    targetOutput: String? = nil,
    instructions: String? = nil
  ) async throws {
    let body: Data?
    if targetOutput != nil || instructions != nil {
      body = try encode(PromoteBody(targetOutput: targetOutput, instructions: instructions))
    } else {
      body = nil
    }
    let _: OkResponse = try await request("POST", "/pods/\(id)/promote", body: body)
  }

  public func triggerValidation(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/pods/\(id)/validate")
  }

  public func forceApprove(_ id: String, reason: String? = nil) async throws {
    let _: OkResponse = try await request(
      "POST", "/pods/\(id)/force-approve",
      body: try encode(ForceApproveBody(reason: reason))
    )
  }

  public func startPreview(_ id: String) async throws -> String {
    let res: PreviewResponse = try await request("POST", "/pods/\(id)/preview")
    return res.previewUrl
  }

  public func revalidateSession(_ id: String) async throws -> RevalidateResponse {
    try await request("POST", "/pods/\(id)/revalidate")
  }

  public func fixManually(_ id: String) async throws -> SessionResponse {
    try await request("POST", "/pods/\(id)/fix-manually")
  }

  public func pauseSession(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/pods/\(id)/pause")
  }

  public func extendAttempts(_ id: String, additionalAttempts: Int) async throws {
    let _: OkResponse = try await request(
      "POST", "/pods/\(id)/extend-attempts",
      body: try encode(ExtendAttemptsBody(additionalAttempts: additionalAttempts))
    )
  }

  public func extendPrAttempts(_ id: String, additionalAttempts: Int) async throws {
    let _: OkResponse = try await request(
      "POST", "/pods/\(id)/extend-pr-attempts",
      body: try encode(ExtendAttemptsBody(additionalAttempts: additionalAttempts))
    )
  }

  public func spawnFixSession(_ id: String, userMessage: String? = nil) async throws {
    let body = try userMessage.map { try encode(SpawnFixBody(userMessage: $0)) }
    let _: OkResponse = try await request("POST", "/pods/\(id)/spawn-fix", body: body)
  }

  public func retryCreatePr(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/pods/\(id)/retry-pr")
  }

  /// Operator escape hatch for `failed` pods — picks the cheapest recovery path
  /// (push + open PR if validation already passed, otherwise re-run validation).
  /// Returns the action the daemon took, so the UI can confirm what happened.
  public func resumePod(_ id: String) async throws -> ResumeResponse {
    try await request("POST", "/pods/\(id)/resume")
  }

  /// Admin override: transition a `failed` pod to `complete`, skipping push/PR/merge.
  /// Reason is optional and persisted as audit metadata on the pod row.
  public func forceComplete(_ id: String, reason: String?) async throws {
    let body = try reason.map { try encode(ForceCompleteBody(reason: $0)) }
    let _: OkResponse = try await request("POST", "/pods/\(id)/force-complete", body: body)
  }

  /// Operator unstick: re-enqueues a stuck queued pod, or kills+fails a stuck
  /// running/provisioning pod so its concurrency slot frees up. Action in the
  /// response says which path the daemon took ("requeued" or "failed").
  public func kickPod(_ id: String, reason: String?) async throws -> KickResponse {
    let body = try reason.map { try encode(KickBody(reason: $0)) }
    return try await request("POST", "/pods/\(id)/kick", body: body)
  }

  public func deletePod(_ id: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/pods/\(id)")
  }

  public func deleteSeries(_ seriesId: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/pods/series/\(seriesId)")
  }

  public func approveAllValidated() async throws -> [String] {
    let results: [SessionSummaryResponse] = try await request("POST", "/pods/approve-all")
    return results.map(\.id)
  }

  public func killAllFailed() async throws -> [String] {
    let results: [SessionSummaryResponse] = try await request("POST", "/pods/kill-failed")
    return results.map(\.id)
  }

  public func getValidationHistory(_ id: String) async throws -> [ValidationResponse] {
    try await request("GET", "/pods/\(id)/validations")
  }

  public func getSessionEvents(_ id: String) async throws -> [AgentEventResponse] {
    try await request("GET", "/pods/\(id)/events")
  }

  public func getPodQuality(_ id: String) async throws -> PodQualitySignals {
    try await request("GET", "/pods/\(id)/quality")
  }

  /// GET /pods/scores — persisted quality-score leaderboard.
  public func listQualityScores(
    runtime: String? = nil,
    model: String? = nil,
    profileName: String? = nil,
    since: String? = nil,
    limit: Int? = nil
  ) async throws -> [PodQualityScore] {
    var query: [String: String] = [:]
    if let runtime { query["runtime"] = runtime }
    if let model { query["model"] = model }
    if let profileName { query["profileName"] = profileName }
    if let since { query["since"] = since }
    if let limit { query["limit"] = "\(limit)" }
    return try await request("GET", "/pods/scores", query: query)
  }

  /// GET /pods/quality/trends — daily average quality scores per runtime/model.
  public func listQualityTrends(days: Int = 30) async throws -> [QualityTrend] {
    try await request("GET", "/pods/quality/trends", query: ["days": "\(days)"])
  }

  public func getSessionDiff(_ id: String) async throws -> DiffApiResponse {
    try await request("GET", "/pods/\(id)/diff")
  }

  // MARK: - Files (worktree browser)

  public func listSessionFiles(_ id: String, ext: String = "md") async throws -> [SessionFileEntry] {
    let res: SessionFilesResponse = try await request(
      "GET", "/pods/\(id)/files", query: ["ext": ext]
    )
    return res.files
  }

  public func getSessionFileContent(_ id: String, path: String) async throws -> SessionFileContent {
    try await request("GET", "/pods/\(id)/files/content", query: ["path": path])
  }

  public func getReportToken(_ id: String) async throws -> (token: String?, reportUrl: String) {
    let res: ReportTokenResponse = try await request("GET", "/pods/\(id)/report/token")
    return (res.token, res.reportUrl)
  }

  // MARK: - Series

  public func getSeries(_ seriesId: String) async throws -> SeriesResponse {
    try await request("GET", "/pods/series/\(seriesId)")
  }

  public func createSeries(_ body: CreateSeriesRequest) async throws -> SeriesResponse {
    try await request("POST", "/pods/series", body: try encode(body))
  }

  /// Ask the daemon to parse a local brief folder and return the DAG preview.
  /// The folder path is resolved on the daemon host — the desktop app and
  /// daemon must share a filesystem (i.e. daemon running locally).
  public func previewSeriesFolder(path: String) async throws -> SeriesPreviewResponse {
    let body = try JSONSerialization.data(withJSONObject: ["folderPath": path])
    return try await request("POST", "/pods/series/preview", body: body)
  }

  /// Parse a brief folder living on a git branch (produced by `/prep` or an
  /// interactive pod). Reads the files directly from the profile's bare repo.
  public func previewSeriesOnBranch(
    profileName: String,
    branch: String,
    path: String
  ) async throws -> SeriesPreviewResponse {
    let body = try JSONSerialization.data(withJSONObject: [
      "profileName": profileName,
      "branch": branch,
      "path": path,
    ])
    return try await request("POST", "/pods/series/preview-branch", body: body)
  }

  // MARK: - Profiles

  public func listProfiles() async throws -> [ProfileResponse] {
    try await request("GET", "/profiles")
  }

  public func getProfile(_ name: String) async throws -> ProfileResponse {
    try await request("GET", "/profiles/\(name)")
  }

  /// Editor-oriented fetch: returns raw + resolved + parent + per-field source map.
  /// Used by the profile editor to render Inherited/Overridden chips.
  public func getProfileEditor(_ name: String) async throws -> ProfileEditorResponse {
    try await request("GET", "/profiles/\(name)/editor")
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
      "POST", "/pods/history-workspace",
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

  // MARK: - Memory

  public func createMemoryWorkspace(profileName: String) async throws -> SessionResponse {
    let body = try JSONSerialization.data(withJSONObject: ["profileName": profileName])
    return try await request("POST", "/pods/memory-workspace", body: body)
  }

  public func listMemories(
    scope: String,
    scopeId: String? = nil,
    approvedOnly: Bool = true
  ) async throws -> [MemoryEntry] {
    var query: [String: String] = ["scope": scope, "approved": approvedOnly ? "true" : "false"]
    if let s = scopeId { query["scopeId"] = s }
    return try await request("GET", "/memory", query: query)
  }

  public func createMemory(scope: String, scopeId: String?, path: String, content: String) async throws -> MemoryEntry {
    let body = try JSONSerialization.data(withJSONObject: [
      "scope": scope,
      "scopeId": scopeId as Any,
      "path": path,
      "content": content,
    ])
    return try await request("POST", "/memory", body: body)
  }

  public func approveMemory(_ id: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["action": "approve"])
    let _: EmptyResponse = try await request("PATCH", "/memory/\(id)", body: body)
  }

  public func rejectMemory(_ id: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["action": "reject"])
    let _: EmptyResponse = try await request("PATCH", "/memory/\(id)", body: body)
  }

  public func updateMemory(_ id: String, content: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["action": "update", "content": content])
    let _: EmptyResponse = try await request("PATCH", "/memory/\(id)", body: body)
  }

  public func deleteMemory(_ id: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/memory/\(id)")
  }

  // MARK: - Scheduled Jobs

  public func listScheduledJobs() async throws -> [ScheduledJob] {
    try await request("GET", "/scheduled-jobs")
  }

  public func getScheduledJob(_ id: String) async throws -> ScheduledJob {
    try await request("GET", "/scheduled-jobs/\(id)")
  }

  public func runScheduledJobCatchup(_ id: String) async throws -> SessionResponse {
    try await request("POST", "/scheduled-jobs/\(id)/catchup")
  }

  public func skipScheduledJobCatchup(_ id: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/scheduled-jobs/\(id)/catchup")
  }

  public func createScheduledJob(_ body: CreateScheduledJobRequest) async throws -> ScheduledJob {
    try await request("POST", "/scheduled-jobs", body: try encode(body))
  }

  public func updateScheduledJob(_ id: String, _ body: UpdateScheduledJobRequest) async throws -> ScheduledJob {
    try await request("PUT", "/scheduled-jobs/\(id)", body: try encode(body))
  }

  public func deleteScheduledJob(_ id: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/scheduled-jobs/\(id)")
  }

  public func triggerScheduledJob(_ id: String) async throws -> SessionResponse {
    try await request("POST", "/scheduled-jobs/\(id)/trigger")
  }

  // MARK: - Validation

  public func interruptValidation(podId: String) async throws {
    let _: EmptyResponse = try await request("POST", "/pods/\(podId)/interrupt-validation")
  }

  public func setSkipValidation(_ id: String, skip: Bool) async throws {
    let _: EmptyResponse = try await request(
      "POST", "/pods/\(id)/skip-validation",
      body: try encode(["skip": skip])
    )
  }

  public func addValidationOverride(
    podId: String,
    findingId: String,
    description: String,
    action: String,
    reason: String? = nil,
    guidance: String? = nil
  ) async throws {
    var dict: [String: Any] = [
      "findingId": findingId,
      "description": description,
      "action": action,
    ]
    if let reason = reason { dict["reason"] = reason }
    if let guidance = guidance { dict["guidance"] = guidance }
    let body = try JSONSerialization.data(withJSONObject: dict)
    let _: EmptyResponse = try await request("POST", "/pods/\(podId)/validation-overrides", body: body)
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
      (data, response) = try await pod.data(for: req)
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
      throw DaemonError.unauthorized(decodeErrorMessage(data))
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

  /// Extract a human-readable message from a daemon error body shaped as
  /// `{"error": "...", "message": "..."}`. Falls back to the raw body string
  /// if it isn't JSON, or nil if there's nothing usable.
  private func decodeErrorMessage(_ data: Data) -> String? {
    struct ErrorBody: Decodable { let message: String? }
    if let body = try? decoder.decode(ErrorBody.self, from: data),
       let message = body.message,
       !message.isEmpty {
      return message
    }
    if let text = String(data: data, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !text.isEmpty {
      return text
    }
    return nil
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

struct ForceApproveBody: Codable {
  let reason: String?
}

struct CompleteBody: Codable {
  let promoteTo: String?
  let instructions: String?
}

struct PromoteBody: Codable {
  let targetOutput: String?
  let instructions: String?
}

struct WarmBody: Codable {
  let rebuild: Bool?
  let gitPat: String?
}

struct ExtendAttemptsBody: Codable {
  let additionalAttempts: Int
}

struct SpawnFixBody: Codable {
  let userMessage: String
}

struct ForceCompleteBody: Codable {
  let reason: String
}

public struct ResumeResponse: Codable, Sendable {
  public let ok: Bool?
  /// Either "retry-pr" (Path 1: push + open PR) or "revalidate" (Path 2: re-run validation only).
  public let action: String?
}

struct KickBody: Codable {
  let reason: String
}

public struct KickResponse: Codable, Sendable {
  public let ok: Bool?
  /// Either "requeued" (queued pod re-enqueued) or "failed" (running/provisioning pod was killed and force-failed).
  public let action: String?
}

struct PreviewResponse: Codable {
  let previewUrl: String
}

struct HistoryWorkspaceBody: Codable {
  let profileName: String?
  let limit: Int?
  let since: String?
  let failuresOnly: Bool?
}

