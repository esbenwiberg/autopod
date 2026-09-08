import Foundation
import Testing
@testable import AutopodClient

@Test func scheduledReportEventDoesNotRequireOrInventAWorker() throws {
  let raw = try JSONDecoder().decode(RawSystemEvent.self, from: Data(#"{"type":"scheduled_job.fired","timestamp":"2026-09-07T10:00:00Z","jobId":"job","jobName":"Report","podId":null,"reportId":"report"}"#.utf8))
  guard case let .scheduledJobFired(jobId, _, podId, reportId) = SystemEvent.parse(raw) else {
    Issue.record("Report event was dropped"); return
  }
  #expect(jobId == "job"); #expect(podId == nil); #expect(reportId == "report")
}

@Test func scheduledScanClientPreservesIncompleteStatusAndExplicitHumanSelection() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ScanFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://scan-fixture.invalid")!, token: "synthetic", session: URLSession(configuration: configuration))
  let report = try await api.triggerScheduledJob("job")
  #expect(report.isReport); #expect(report.status == "incomplete")
  let detail = try await api.getScanReport("report")
  #expect(detail.report.collection?.scanners.first?.findingCount == nil)
  #expect(detail.unresolved.count == 1); #expect(detail.decisions.isEmpty)
  let decision = try await api.triageScanReport("report", ScanTriageRequest(requestKey: "stable-key", findingIds: ["finding"], action: "select_repair", reason: "Human selection"))
  #expect(decision.id == "selection"); #expect(decision.repairPodId == nil)
  let receipt = try await api.launchScanRepair("report", selectionId: decision.id)
  #expect(receipt.kind == "repair_dispatch"); #expect(receipt.podId == "repair")
}

@Test func scanHistoryClientFollowsExplicitPageCursor() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ScanFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://scan-fixture.invalid")!, token: "synthetic", session: URLSession(configuration: configuration))
  let page = try await api.listScanReportPage("job")
  #expect(page.nextCursor == "cursor")
  let older = try await api.listScanReportPage("job", before: page.nextCursor)
  #expect(older.nextCursor == nil)
  #expect(older.items.first?.findingCount == nil)
  #expect(older.items.first?.status == "incomplete")
}

@Test func apiProvenanceClientSendsVersionAsQueryParameter() async throws {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ScanFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://scan-fixture.invalid")!, token: "synthetic", session: URLSession(configuration: configuration))
  let result = try await api.getExecutionProvenance("pod")
  #expect(result.latest == nil)
}

@Test func scanReviewClientUsesIndependentFindingAndDecisionCursors() async throws {
  let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ScanFixtureProtocol.self]
  let api = DaemonAPI(baseURL: URL(string: "https://scan-fixture.invalid")!, token: "synthetic", session: URLSession(configuration: configuration))
  let review = try await api.getScanReportReview("report")
  #expect(review.unresolved.count == 1)
  let findings = try await api.getScanFindings("report", after: "finding")
  #expect(findings.nextCursor == nil)
  let decisions = try await api.getScanDecisions("report", before: "decision")
  #expect(decisions.nextCursor == nil)
}

private final class ScanFixtureProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "scan-fixture.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    if path.contains("execution-provenance") {
      #expect(path == "/pods/pod/execution-provenance")
      #expect(request.url?.query == "schemaVersion=2")
    }
    let finding = #"{"id":"finding","scanner":"secrets","ruleId":"fixture","file":"source.ts","severity":"high","summary":"Redacted fixture","disposition":"unresolved"}"#
    let report = #"{"kind":"scan_report","id":"report","jobId":"job","status":"incomplete","policy":{"version":1,"baseRef":"main","headRef":"main","scanners":["secrets"],"judgment":"none","windowHours":24},"collection":{"repository":"fixture","files":[],"stacks":[],"scanners":[{"scanner":"secrets","status":"failed","findingCount":null}],"findings":[],"diagnostics":["Scanner unavailable"]},"judgment":{"status":"not_requested"},"createdAt":"2026-09-07T10:00:00Z","completedAt":"2026-09-07T10:01:00Z"}"#
    let body: String
    if path.hasSuffix("/findings") {
      #expect(request.url?.query == "after=finding"); body = #"{"items":[],"nextCursor":null}"#
    } else if path.hasSuffix("/decisions") {
      #expect(request.url?.query == "before=decision"); body = #"{"items":[],"nextCursor":null}"#
    } else if path.hasSuffix("/execution-provenance") {
      #expect(request.url?.query == "schemaVersion=2")
      body = #"{"latest":null}"#
    }
    else if path.hasSuffix("/report-page") {
      #expect(request.httpMethod == "GET")
      if request.url?.query == "before=cursor" { body = #"{"items":[{"id":"old","jobId":"job","status":"incomplete","createdAt":"today","findingCount":null,"judgmentStatus":null,"diagnostics":["Unavailable summary"]}],"nextCursor":null}"# }
      else { body = #"{"items":[],"nextCursor":"cursor"}"# }
    }
    else if path.hasSuffix("/trigger") { body = report }
    else if path.hasSuffix("/triage") {
      #expect(request.httpMethod == "POST")
      body = #"{"id":"selection","findingIds":["finding"],"action":"select_repair","reason":"Human selection","actor":{"type":"human","userId":"operator"},"createdAt":"2026-09-07T10:02:00Z"}"#
    } else if path.hasSuffix("/repairs") {
      #expect(request.httpMethod == "POST")
      body = #"{"kind":"repair_dispatch","selectionId":"selection","podId":"repair"}"#
    } else { body = "{\"report\":\(report),\"unresolved\":[\(finding)],\"decisions\":[]}" }
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@Test func unavailableScanJudgmentPreservesKnownUsage() throws {
  let data = Data(#"{"status":"unavailable","text":"Output incomplete; known usage retained.","usage":{"inputTokens":25,"outputTokens":7,"costUsd":null,"durationMs":14500,"model":"bound-model","provider":"max","providerAccountId":null}}"#.utf8)
  let judgment = try JSONDecoder().decode(ScheduledScanReport.Judgment.self, from: data)
  #expect(judgment.status == "unavailable")
  #expect(judgment.usage?.inputTokens == 25); #expect(judgment.usage?.outputTokens == 7)
  #expect(judgment.usage?.costUsd == nil); #expect(judgment.usage?.durationMs == 14500)
}
