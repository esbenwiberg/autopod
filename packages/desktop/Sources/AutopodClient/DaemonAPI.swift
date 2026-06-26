import Foundation

/// Async REST client for the Autopod daemon API.
/// Actor-isolated for thread safety — all methods are safe to call from any context.
public actor DaemonAPI {
  public nonisolated let baseURL: URL
  public let token: String
  private let pod: URLSession
  private let decoder: JSONDecoder
  private let encoder: JSONEncoder

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = Self.normalizeBearerToken(token)
    self.pod = URLSession.shared
    self.decoder = JSONDecoder()
    self.encoder = JSONEncoder()
  }

  public static func normalizeBearerToken(_ token: String) -> String {
    let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.lowercased().hasPrefix("bearer ") {
      return String(trimmed.dropFirst("Bearer ".count))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return trimmed
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

  public func approvePod(_ id: String, squash: Bool? = nil, reason: String? = nil) async throws {
    let trimmedReason = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
    let body: Data? = if squash != nil || trimmedReason?.isEmpty == false {
      try encode(ApproveBody(squash: squash, reason: trimmedReason?.isEmpty == false ? trimmedReason : nil))
    } else {
      nil
    }
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

  /// Commit + push a running workspace's branch without changing pod state.
  /// Best-effort — daemon returns ok=false with an error string on failure
  /// rather than throwing, so callers can fall through (e.g. open the Create
  /// Series sheet anyway and let the user pick local-folder mode).
  public func syncWorkspaceBranch(_ id: String) async throws -> SyncBranchResponse {
    return try await request("POST", "/pods/\(id)/sync-branch")
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
  /// `skipAgent` bypasses the runtime spawn entirely — the pod goes straight to
  /// validation/PR with the human's commits as-is. Daemon refuses the combo with
  /// `targetOutput == "none"`.
  public func promoteSession(
    _ id: String,
    targetOutput: String? = nil,
    instructions: String? = nil,
    skipAgent: Bool = false
  ) async throws {
    let body: Data?
    if targetOutput != nil || instructions != nil || skipAgent {
      body = try encode(PromoteBody(
        targetOutput: targetOutput,
        instructions: instructions,
        skipAgent: skipAgent ? true : nil
      ))
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

  public func approveFactWaiver(podId: String, factId: String, reason: String? = nil) async throws {
    let _: EmptyResponse = try await request(
      "POST", "/pods/\(podId)/facts/\(factId)/approve-waiver",
      body: try encode(FactWaiverBody(reason: reason))
    )
  }

  public func startPreview(_ id: String) async throws -> String {
    let res: PreviewResponse = try await request("POST", "/pods/\(id)/preview")
    return res.previewUrl
  }

  public func previewStatus(podId: String) async throws -> PreviewStatus {
    try await request("GET", "/pods/\(podId)/preview/status")
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

  public func spawnFixSession(_ id: String, userMessage: String? = nil) async throws -> SpawnFixResponse {
    let body = try encode(SpawnFixBody(message: userMessage ?? ""))
    return try await request("POST", "/pods/\(id)/spawn-fix", body: body)
  }

  public func retryCreatePr(_ id: String) async throws {
    let _: OkResponse = try await request("POST", "/pods/\(id)/retry-pr")
  }

  /// Recover a worktree-compromised pod. The daemon tries the live container
  /// first, then falls back to restoring deleted files from HEAD when the
  /// agent's commits are already safe on the bare repo. Returns the daemon's
  /// outcome so the UI can surface the human-readable reason on either path.
  public func recoverWorktree(_ id: String) async throws -> RecoverWorktreeResponse {
    try await request("POST", "/pods/\(id)/recover-worktree")
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

  public func approveAllValidated() async throws -> ApproveAllResponse {
    try await request("POST", "/pods/approve-all")
  }

  public func killAllFailed() async throws -> [String] {
    let results: [SessionSummaryResponse] = try await request("POST", "/pods/kill-failed")
    return results.map(\.id)
  }

  public func getValidationHistory(_ id: String) async throws -> [StoredValidationResponse] {
    try await request("GET", "/pods/\(id)/validations")
  }

  public func getSessionEvents(_ id: String, limit: Int? = nil) async throws -> [AgentEventResponse] {
    var query: [String: String] = [:]
    if let limit { query["limit"] = "\(limit)" }
    return try await request("GET", "/pods/\(id)/events", query: query)
  }

  public func getFirewallDenials(
    _ id: String,
    limit: Int? = nil,
    until: String? = nil
  ) async throws -> [FirewallDenialResponse] {
    var query: [String: String] = [:]
    if let limit { query["limit"] = "\(limit)" }
    if let until { query["until"] = until }
    return try await request("GET", "/pods/\(id)/firewall-denials", query: query)
  }

  public func getActionAudit(
    _ id: String,
    limit: Int? = nil,
    until: String? = nil
  ) async throws -> ActionAuditResponse {
    var query: [String: String] = [:]
    if let limit { query["limit"] = "\(limit)" }
    if let until { query["until"] = until }
    return try await request("GET", "/pods/\(id)/action-audit", query: query)
  }

  public func getPodQuality(_ id: String) async throws -> PodQualitySignals {
    try await request("GET", "/pods/\(id)/quality")
  }

  public func getPodCost(_ id: String) async throws -> PodCostBreakdownResponse {
    try await request("GET", "/pods/\(id)/cost")
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

  /// GET /pods/analytics/cost — 30-day cost breakdown with sparkline, per-phase,
  /// profile×model, top-10, and waste summary.
  public func getCostAnalytics(days: Int = 30) async throws -> CostAnalyticsResponse {
    try await request("GET", "/pods/analytics/cost", query: ["days": "\(days)"])
  }

  /// GET /pods/analytics/reliability — trailing-window first-pass rate, funnel,
  /// stage failures, profile heatmap, and summary.
  public func getReliabilityAnalytics(days: Int = 30) async throws -> ReliabilityAnalyticsResponse {
    try await request("GET", "/pods/analytics/reliability", query: ["days": "\(days)"])
  }

  /// GET /pods/analytics/quality — trailing-window quality score analytics with
  /// histogram, reason breakdown, and full scores list.
  public func getQualityAnalytics(days: Int = 30) async throws -> QualityAnalyticsResponse {
    try await request("GET", "/pods/analytics/quality", query: ["days": "\(days)"])
  }

  /// GET /pods/analytics/safety — trailing-window guardrail-fire totals with
  /// PII-by-pattern, quarantine histogram, injection table, audit-chain status,
  /// and network-policy distribution.
  public func getSafetyAnalytics(days: Int = 30) async throws -> SafetyAnalyticsResponse {
    try await request("GET", "/pods/analytics/safety", query: ["days": "\(days)"])
  }

  /// GET /pods/analytics/throughput — trailing-window throughput summary, per-pod
  /// cohort, hourly queue-depth time-series, and time-in-status box-plot stats.
  public func getThroughputAnalytics(days: Int = 30) async throws -> ThroughputAnalyticsResponse {
    try await request("GET", "/pods/analytics/throughput", query: ["days": "\(days)"])
  }

  /// GET /pods/analytics/escalations — trailing-window self-recovery rate, ask_human TTR
  /// histogram, per-profile escalation rates, and top-10 blocker patterns.
  public func getEscalationsAnalytics(days: Int = 30) async throws -> EscalationsAnalyticsResponse {
    try await request("GET", "/pods/analytics/escalations", query: ["days": "\(days)"])
  }

  /// GET /pods/analytics/models — trailing-window per-model leaderboard, per-runtime aggregates,
  /// failure-stage matrix, and unknown-model samples.
  public func getModelsAnalytics(days: Int = 30) async throws -> ModelsAnalyticsResponse {
    try await request("GET", "/pods/analytics/models", query: ["days": "\(days)"])
  }

  /// GET /pods/analytics/memory — evidence-only memory effectiveness card.
  public func getMemoryAnalytics(days: Int = 30) async throws -> MemoryAnalyticsResponse {
    try await request("GET", "/pods/analytics/memory", query: ["days": "\(days)"])
  }

  /// POST /audit-chain/verify — runs a fleet-wide audit-chain integrity check.
  /// Records the result in `audit_chain_verifications` and returns a summary.
  public func verifyAuditChain() async throws -> AuditChainVerifyResponse {
    try await request("POST", "/audit-chain/verify")
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

  /// Parse a contract-backed brief folder living on a git branch (produced by
  /// `/plan-feature` or an interactive pod). Reads the files directly from the
  /// profile's bare repo.
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

  /// Ask the daemon to parse one `/prep` folder containing `brief.md` and
  /// `contract.yaml`.
  public func previewBriefFolder(path: String) async throws -> ParsedBriefResponse {
    let body = try JSONSerialization.data(withJSONObject: ["folderPath": path])
    return try await request("POST", "/pods/brief/preview", body: body)
  }

  /// Parse one `/prep` folder living on a git branch.
  public func previewBriefOnBranch(
    profileName: String,
    branch: String,
    path: String
  ) async throws -> ParsedBriefResponse {
    let body = try JSONSerialization.data(withJSONObject: [
      "profileName": profileName,
      "branch": branch,
      "path": path,
    ])
    return try await request("POST", "/pods/brief/preview-branch", body: body)
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

  // MARK: - Skills

  public func fetchBuiltinSkills() async throws -> [BuiltinSkillEntry] {
    struct Response: Codable { let skills: [BuiltinSkillEntry] }
    let res: Response = try await request("GET", "/api/skills")
    return res.skills
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

  public func listMemoryCandidates(
    scopeId: String,
    status: MemoryCandidateStatus? = .pending
  ) async throws -> [MemoryCandidate] {
    var query = ["scopeId": scopeId]
    if let status { query["status"] = status.queryValue }
    return try await request("GET", "/memory/candidates", query: query)
  }

  public func listAllMemoryCandidates(scopeId: String) async throws -> [MemoryCandidate] {
    try await request("GET", "/memory/candidates", query: ["scopeId": scopeId, "status": "all"])
  }

  public func getMemoryCandidateSourceEvidence(_ id: String) async throws -> MemorySourceEvidenceResponse {
    try await request("GET", "/memory/candidates/\(id)/source-evidence")
  }

  public func listMemoryExtractionAttempts(
    profileName: String,
    limit: Int = 20
  ) async throws -> [MemoryExtractionAttempt] {
    try await request(
      "GET",
      "/memory/extraction-attempts",
      query: ["profileName": profileName, "limit": "\(limit)"]
    )
  }

  public func approveMemoryCandidate(_ id: String) async throws -> MemoryCandidate {
    try await request(
      "PATCH",
      "/memory/candidates/\(id)",
      body: try encode(MemoryCandidatePatchBody(action: "approve"))
    )
  }

  public func rejectMemoryCandidate(_ id: String) async throws -> MemoryCandidate {
    try await request(
      "PATCH",
      "/memory/candidates/\(id)",
      body: try encode(MemoryCandidatePatchBody(action: "reject"))
    )
  }

  public func updateMemoryCandidate(
    _ id: String,
    updates: MemoryCandidateUpdate
  ) async throws -> MemoryCandidate {
    try await request(
      "PATCH",
      "/memory/candidates/\(id)",
      body: try encode(MemoryCandidatePatchBody(action: "update", updates: updates))
    )
  }

  public func getMemoryUsage(_ id: String) async throws -> MemoryUsageResponse {
    try await request("GET", "/memory/\(id)/usage")
  }

  public func getMemorySourceEvidence(_ id: String) async throws -> MemorySourceEvidenceResponse {
    try await request("GET", "/memory/\(id)/source-evidence")
  }

  public func getMemoryStaleEvidence(_ id: String) async throws -> MemoryUsageEvidenceResponse {
    try await request("GET", "/memory/\(id)/stale-evidence")
  }

  public func getMemoryHarmfulEvidence(_ id: String) async throws -> MemoryUsageEvidenceResponse {
    try await request("GET", "/memory/\(id)/harmful-evidence")
  }

  // MARK: - Scheduled Jobs

  public func listScheduledJobTemplates() async throws -> [ScheduledJobTemplate] {
    try await request("GET", "/scheduled-job-templates")
  }

  public func getScheduledJobTemplate(_ id: String) async throws -> ScheduledJobTemplate {
    try await request("GET", "/scheduled-job-templates/\(id)")
  }

  public func createScheduledJobTemplate(_ body: CreateScheduledJobTemplateRequest) async throws -> ScheduledJobTemplate {
    try await request("POST", "/scheduled-job-templates", body: try encode(body))
  }

  public func updateScheduledJobTemplate(_ id: String, _ body: UpdateScheduledJobTemplateRequest) async throws -> ScheduledJobTemplate {
    try await request("PUT", "/scheduled-job-templates/\(id)", body: try encode(body))
  }

  public func deleteScheduledJobTemplate(_ id: String) async throws {
    let _: EmptyResponse = try await request("DELETE", "/scheduled-job-templates/\(id)")
  }

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

  public func updateFromBase(_ id: String) async throws -> UpdateFromBaseResponse {
    let path = "/pods/\(id)/update-from-base"
    let url = try makeRequestURL(path)
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.timeoutInterval = 30
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
      do { return try decoder.decode(UpdateFromBaseResponse.self, from: data) }
      catch { throw DaemonError.decodingError("\(error)") }
    case 409:
      // 409 is either a typed conflict result or an INVALID_STATE error.
      if let result = try? decoder.decode(UpdateFromBaseResponse.self, from: data),
         result.action == "conflict" {
        return result
      }
      let msg = decodeErrorMessage(data) ?? "Invalid state"
      throw DaemonError.serverError(409, msg)
    case 400:
      let msg = decodeErrorMessage(data) ?? "Bad request"
      throw DaemonError.badRequest(msg)
    case 401:
      throw DaemonError.unauthorized(decodeErrorMessage(data))
    case 404:
      throw DaemonError.notFound(path)
    default:
      let msg = decodeErrorMessage(data) ?? "Unknown error"
      throw DaemonError.serverError(http.statusCode, msg)
    }
  }

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
    let url = try makeRequestURL(path, query: query)

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
      let msg = decodeErrorMessage(data) ?? "Bad request"
      throw DaemonError.badRequest(msg)
    default:
      let msg = decodeErrorMessage(data) ?? "Unknown error"
      throw DaemonError.serverError(http.statusCode, msg)
    }
  }

  nonisolated func makeRequestURL(_ path: String, query: [String: String] = [:]) throws -> URL {
    var components = URLComponents(
      url: baseURL.appendingPathComponent(path),
      resolvingAgainstBaseURL: false
    )!
    if !query.isEmpty {
      components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
    }
    guard let url = components.url else {
      throw DaemonError.networkError("Invalid URL: \(path)")
    }
    return url
  }

  /// Extract a human-readable message from a daemon error body shaped as
  /// `{"error": "...", "message": "..."}`. Falls back to the raw body string
  /// if it isn't JSON, or nil if there's nothing usable.
  private func decodeErrorMessage(_ data: Data) -> String? {
    struct ErrorBody: Decodable {
      let error: String?
      let message: String?
    }
    if let body = try? decoder.decode(ErrorBody.self, from: data),
       let message = body.message,
       !message.isEmpty {
      return message
    }
    if let body = try? decoder.decode(ErrorBody.self, from: data),
       let error = body.error,
       !error.isEmpty {
      return error
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

public struct ApproveAllResponse: Codable, Sendable {
  public let approved: [String]
  public let skipped: [ApproveAllSkippedResponse]?
}

public struct ApproveAllSkippedResponse: Codable, Sendable {
  public let podId: String
  public let status: String
  public let reason: String
}

struct HealthResponse: Codable {
  let status: String
}

struct VersionResponse: Codable {
  let version: String
}

private struct MemoryCandidatePatchBody: Encodable {
  let action: String
  let path: String?
  let content: String?
  let rationale: String?
  let kind: MemoryKind?
  let tags: [String]?
  let appliesWhen: String?
  let avoidWhen: String?
  let confidence: Double?
  let sourceEvidence: [MemorySourceEvidence]?
  let impactSummary: String?

  init(action: String, updates: MemoryCandidateUpdate? = nil) {
    self.action = action
    self.path = updates?.path
    self.content = updates?.content
    self.rationale = updates?.rationale
    self.kind = updates?.kind
    self.tags = updates?.tags
    self.appliesWhen = updates?.appliesWhen
    self.avoidWhen = updates?.avoidWhen
    self.confidence = updates?.confidence
    self.sourceEvidence = updates?.sourceEvidence
    self.impactSummary = updates?.impactSummary
  }
}

struct MessageBody: Codable {
  let message: String
}

struct ApproveBody: Codable {
  let squash: Bool?
  let reason: String?
}

struct RejectBody: Codable {
  let feedback: String?
}

struct ForceApproveBody: Codable {
  let reason: String?
}

struct FactWaiverBody: Codable {
  let reason: String?
}

struct CompleteBody: Codable {
  let promoteTo: String?
  let instructions: String?
}

struct PromoteBody: Codable {
  let targetOutput: String?
  let instructions: String?
  let skipAgent: Bool?
}

struct WarmBody: Codable {
  let rebuild: Bool?
  let gitPat: String?
}

struct ExtendAttemptsBody: Codable {
  let additionalAttempts: Int
}

struct SpawnFixBody: Codable {
  let message: String
}

/// Response from POST /pods/:id/spawn-fix (brief 03 contract).
public struct SpawnFixResponse: Codable, Sendable {
  public let ok: Bool
  public let queued: Bool?
  public let queueLength: Int?
  public let fixPodId: String?
  /// Set when ok == false. Value is "parent_terminal" when the parent pod is in a terminal state.
  public let reason: String?
}

struct ForceCompleteBody: Codable {
  let reason: String
}

public struct ResumeResponse: Codable, Sendable {
  public let ok: Bool?
  /// "retry-pr" (push + open PR), "revalidate" (validation only), or
  /// "retry-fix-delivery" (push an already-validated fix pod).
  public let action: String?
}

/// Daemon's response to POST /pods/:id/recover-worktree. `recovered=true` means
/// the worktreeCompromised flag was cleared and the pod is resumable again.
/// `message` is human-readable context (e.g. "Restored 62 deleted files from
/// HEAD" on success, or the safety check that refused on failure).
public struct RecoverWorktreeResponse: Codable, Sendable {
  public let recovered: Bool
  public let message: String
  public let blockers: [RecoverWorktreeBlocker]?
}

public struct RecoverWorktreeBlocker: Codable, Sendable {
  public let status: String
  public let path: String
}

public struct SyncBranchResponse: Codable, Sendable {
  public let ok: Bool?
  public let committed: Bool?
  public let pushed: Bool?
  public let error: String?
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

public struct PreviewStatus: Decodable, Sendable {
  public let running: Bool
  public let reachable: Bool
  public let restartCount: Int
  public let lastError: String?
  public let previewUrl: String?

  public init(
    running: Bool,
    reachable: Bool,
    restartCount: Int,
    lastError: String?,
    previewUrl: String?
  ) {
    self.running = running
    self.reachable = reachable
    self.restartCount = restartCount
    self.lastError = lastError
    self.previewUrl = previewUrl
  }
}

struct HistoryWorkspaceBody: Codable {
  let profileName: String?
  let limit: Int?
  let since: String?
  let failuresOnly: Bool?
}

/// Response from POST /pods/:id/update-from-base.
/// The conflict outcome arrives as HTTP 409 but is decoded as a typed result
/// (not an error) when `action == "conflict"`. All other 409s are INVALID_STATE.
public struct UpdateFromBaseResponse: Codable, Sendable {
  public let ok: Bool
  /// One of: "queued_after_abort" | "already_up_to_date" | "rebased" | "conflict"
  public let action: String
  public let baseBranch: String?
  /// "started" when the daemon kicked off a follow-up validation run.
  public let validation: String?
  /// Non-empty only when action == "conflict".
  public let conflicts: [String]?
}
