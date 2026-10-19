import AutopodClient
import AutopodUI
import Foundation
import Observation

/// Fictional schedule state for Preview and owned-view layout checks. No network calls.
@MainActor @Observable final class DesktopScheduleFixtures {
  var jobs = DesktopScheduleFixtures.initialJobs
  var templates = DesktopScheduleFixtures.initialTemplates
  var failWrites = false
  nonisolated static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
    do { return try JSONDecoder().decode(type, from: Data(json.utf8)) }
    catch { preconditionFailure("Invalid schedule fixture: \(error)") }
  }
  static let initialTemplates = [
    ScheduledJobTemplate(id: "logs", name: "Log triage", prompt: "Review logs for {{service}} over the last {{hours}} hours. Summarize actionable failures.", fields: [.init(key: "service", label: "Service", required: true, defaultValue: "api"), .init(key: "hours", label: "Lookback hours", required: false, defaultValue: "24")], createdAt: "2026-10-17T09:00:00Z", updatedAt: "2026-10-17T09:00:00Z"),
    ScheduledJobTemplate(id: "health", name: "Repository health", prompt: "Collect secrets and dependency findings. Keep reports separate from repairs.", createdAt: "2026-10-17T09:00:00Z", updatedAt: "2026-10-17T09:00:00Z"),
    ScheduledJobTemplate(id: "deps", name: "Dependency maintenance", prompt: "Review outdated dependencies in {{scope}} and run validation.", fields: [.init(key: "scope", label: "Package scope", required: true, defaultValue: "workspace")], createdAt: "2026-10-17T09:00:00Z", updatedAt: "2026-10-17T09:00:00Z")
  ]
  static var initialJobs: [ScheduledJob] {
    [("triage", "Morning log triage", "logs", "repo-backend", "profile-backend", true, true),
     ("security", "Repository health pulse", "health", "repo-backend", "profile-backend", true, false),
     ("frontend", "Frontend dependency review", "deps", "repo-web", "profile-frontend", true, false),
     ("maintenance", "Weekly maintenance", "deps", "repo-research", "profile-research", false, false)].map { id, name, templateID, repoID, profileID, enabled, catchup in
      let template = initialTemplates.first { $0.id == templateID }!
      return ScheduledJob(id: id, name: name, templateId: templateID, templateName: template.name,
        launch: ["repositoryId": .string(repoID), "profileId": .string(profileID)], task: template.fields.reduce(template.prompt) { text, field in text.replacingOccurrences(of: "{{\(field.key)}}", with: field.defaultValue ?? "") },
        cronExpression: id == "triage" ? "0 9 * * 1-5" : "0 10 * * *", enabled: enabled,
        nextRunAt: "2026-10-19T09:00:00Z", lastRunAt: "2026-10-17T09:00:00Z",
        lastPodId: id == "triage" ? "retry-demo" : nil, catchupPending: catchup,
        createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-17T09:00:00Z",
        scan: id == "security" ? ScheduledScanPolicy(baseRef: "main", headRef: "main", scanners: ["secrets", "dependencies"], windowHours: 24) : nil,
        lastReportId: id == "security" ? "fixture-report" : nil)
    }
  }
  func checkWrite() throws { if failWrites { throw DaemonError.serverError(409, "Simulated save failure. Your draft has been retained.") } }
  func update(_ id: String, _ request: UpdateScheduledJobRequest) throws {
    try checkWrite()
    guard let index = jobs.firstIndex(where: { $0.id == id }) else { throw DaemonError.badRequest("Sample schedule unavailable") }
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(jobs[index])) as! [String: Any]
    let changes = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
    object.merge(changes) { _, value in value }
    if let template = templates.first(where: { $0.id == request.templateId }) { object["templateName"] = template.name; object["task"] = template.prompt }
    jobs[index] = try JSONDecoder().decode(ScheduledJob.self, from: JSONSerialization.data(withJSONObject: object))
  }
}

extension DesktopScheduleFixtures {
  var actions: ScheduledWorkspaceActions {
    ScheduledWorkspaceActions(
      reload: {},
      run: { job, _ in
        try self.checkWrite(); try self.clearCatchup(job.id)
        return job.scan == nil ? "Fixture pod retry-demo started. No real pod was launched." : "Fixture report ready. Delivery remains unverified."
      },
      skip: { job in try self.checkWrite(); try self.clearCatchup(job.id) },
      create: { request in
        try self.checkWrite()
        let template = self.templates.first { $0.id == request.templateId } ?? Self.initialTemplates[0]
        self.jobs.append(ScheduledJob(id: UUID().uuidString, name: template.name,
          templateId: template.id, templateName: template.name, profileName: request.profileName,
          launch: request.launch, task: template.prompt, fieldValues: request.fieldValues ?? [:],
          cronExpression: request.cronExpression, enabled: request.enabled,
          nextRunAt: "2026-10-19T09:00:00Z", lastRunAt: nil, lastPodId: nil,
          catchupPending: false, createdAt: "2026-10-17T09:00:00Z", updatedAt: "2026-10-17T09:00:00Z"))
      },
      update: { try self.update($0, $1) },
      delete: { job in try self.checkWrite(); self.jobs.removeAll { $0.id == job.id } },
      createTemplate: { request in
        try self.checkWrite()
        self.templates.append(ScheduledJobTemplate(id: UUID().uuidString, name: request.name,
          prompt: request.prompt, fields: request.fields ?? [], createdAt: "2026-10-17T09:00:00Z", updatedAt: "2026-10-17T09:00:00Z"))
      },
      updateTemplate: { id, request in
        try self.checkWrite()
        guard let index = self.templates.firstIndex(where: { $0.id == id }) else { return }
        let old = self.templates[index]
        self.templates[index] = ScheduledJobTemplate(id: id, name: request.name ?? old.name,
          prompt: request.prompt ?? old.prompt, fields: request.fields ?? old.fields,
          createdAt: old.createdAt, updatedAt: "2026-10-17T09:00:00Z")
      },
      deleteTemplate: { template in
        try self.checkWrite()
        guard !self.jobs.contains(where: { $0.templateId == template.id }) else { throw DaemonError.badRequest("Linked templates cannot be deleted") }
        self.templates.removeAll { $0.id == template.id }
      })
  }
  private func clearCatchup(_ id: String) throws {
    guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(jobs[index])) as! [String: Any]
    object["catchupPending"] = false
    jobs[index] = try JSONDecoder().decode(ScheduledJob.self, from: JSONSerialization.data(withJSONObject: object))
  }
}

actor DesktopScanFixtures: ScanInboxAPI {
  nonisolated let baseURL = URL(string: "https://fixtures.invalid/autopod")!
  private var decisions: [ScanTriageDecision] = []
  private var receipts: [String: String] = [:]
  private var requestResults: [String: ScanTriageDecision] = [:]
  private let scenario: String
  init(scenario: String = "complete") { self.scenario = scenario }
  private func decode<T: Decodable>(_ value: [String: Any]) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value))
  }
  func listScanReportPage(_ jobID: String, before: String?) async throws -> ScanReportPage {
    try decode(["items": before == nil ? [["id": "fixture-report", "jobId": jobID, "status": scenario,
      "createdAt": "2026-10-17T10:00:00Z", "findingCount": 3, "diagnostics": []]] : [], "nextCursor": NSNull()])
  }
  func getScanReportReview(_ id: String) async throws -> ScanReportDetail {
    let findings: [[String: Any]] = [
      ["id": "fixture-f1", "scanner": "secrets", "ruleId": "sample-credential", "file": "config/sample.env", "line": 12, "severity": "high", "summary": "Credential-like value in a tracked configuration file"],
      ["id": "fixture-f2", "scanner": "dependencies", "ruleId": "sample-advisory", "file": "packages/api/package.json", "line": 28, "severity": "high", "summary": "Dependency version matches a sample advisory"],
      ["id": "fixture-f3", "scanner": "dependencies", "ruleId": "earlier-unresolved", "file": "packages/web/package.json", "line": 34, "severity": "medium", "summary": "Earlier unresolved dependency finding"]]
    let noDelta = scenario == "empty_delta"
    let report: [String: Any] = ["kind": "scan_report", "id": id, "jobId": "security", "status": scenario == "evidence_unavailable" ? "complete" : scenario,
      "createdAt": "2026-10-17T10:00:00Z", "completedAt": "2026-10-17T10:01:00Z",
      "policy": ["version": 1, "baseRef": "main", "headRef": "main", "windowHours": 24, "scanners": ["secrets", "dependencies"], "judgment": "none"],
      "collection": ["repository": "acme/autopod", "baseSha": "17ab2cd8", "headSha": noDelta ? "17ab2cd8" : "9de34fa1",
        "window": ["start": "2026-10-16T10:00:00Z", "end": "2026-10-17T10:00:00Z", "semantics": "first-parent net delta", "selectedCommits": noDelta ? [] : ["ab12cd34", "bc23de45"]],
        "files": noDelta ? [] : [["path": "config/sample.env", "change": "modified"], ["path": "packages/api/package.json", "change": "modified"]],
        "stacks": ["node"], "scanners": [["scanner": "secrets", "version": "fixture", "status": noDelta ? "not_run" : "complete", "findingCount": noDelta ? 0 : 1], ["scanner": "dependencies", "version": "fixture", "status": noDelta ? "not_run" : scenario == "incomplete" ? "failed" : "complete", "findingCount": noDelta ? 0 : 2]],
        "findings": noDelta ? [] : findings, "diagnostics": scenario == "incomplete" ? ["Dependency metadata request timed out; coverage is incomplete."] : []],
      "judgment": ["status": "not_requested"],
      "evidenceDiagnostics": scenario == "evidence_unavailable" ? ["Sample evidence artifact could not be read. A clean result cannot be verified."] : []]
    let data = try JSONSerialization.data(withJSONObject: ["report": report, "unresolved": findings, "decisions": []])
    var detail = try JSONDecoder().decode(ScanReportDetail.self, from: data)
    detail.decisions = decisions
    return detail
  }
  func getScanFindings(_ id: String, after: String?) async throws -> ScanFindingPage { try decode(["items": []]) }
  func getScanDecisions(_ id: String, before: String?) async throws -> ScanDecisionPage { try decode(["items": []]) }
  func updateScheduledJob(_ id: String, _ body: UpdateScheduledJobRequest) async throws -> ScheduledJob {
    await MainActor.run { DesktopScheduleFixtures.initialJobs[1] }
  }
  func triageScanReport(_ id: String, _ body: ScanTriageRequest) async throws -> ScanTriageDecision {
    if let existing = requestResults[body.requestKey] { return existing }
    let decision: ScanTriageDecision = try decode(["id": UUID().uuidString, "findingIds": body.findingIds,
      "action": body.action, "reason": body.reason, "actor": ["type": "human", "displayName": "Sample reviewer"], "createdAt": "2026-10-17T10:16:00Z"])
    decisions.append(decision); requestResults[body.requestKey] = decision
    return decision
  }
  func launchScanRepair(_ reportID: String, selectionId: String) async throws -> ScanRepairDispatch {
    let podID = receipts[selectionId] ?? "fixture-repair"
    receipts[selectionId] = podID
    if let index = decisions.firstIndex(where: { $0.id == selectionId }) {
      var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decisions[index])) as! [String: Any]
      object["repairPodId"] = podID
      decisions[index] = try JSONDecoder().decode(ScanTriageDecision.self, from: JSONSerialization.data(withJSONObject: object))
    }
    return try decode(["kind": "repair_dispatch", "selectionId": selectionId, "podId": podID])
  }
}
