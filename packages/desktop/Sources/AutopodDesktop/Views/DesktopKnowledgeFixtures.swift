import AutopodClient
import AutopodUI
import CryptoKit
import Foundation

/// Explicit Preview-mode fixtures. The URL protocol handles only this fictional host.
@MainActor @Observable final class DesktopKnowledgeFixtures {
    var entries = DesktopKnowledgeFixtures.seedEntries
    var candidates = DesktopKnowledgeFixtures.seedCandidates
    var failWrites = false
    var selectedMemoryID: String?
    var selectedCandidateID: String?
    var selectedManagedID: String? = "managed-recovery-demo"
    let api = DesktopKnowledgeFixtures.makeAPI()
    static let evidence = [MemorySourceEvidence(podId: "retry-demo", signal: "verified_recovery", excerpt: "All three artifacts were verified before the interrupted handoff resumed.", severity: .low)]
    static let seedEntries = [
        MemoryEntry(id: "restore-note", scope: .global, path: "/checkpoints/restore.md", content: "Verify recorded artifact digests before reusing downloaded files.\n\nRetain valid artifacts and resume from the first unfinished step.", rationale: "Verified recovery avoids repeating completed work and detects partial writes.", kind: .workflow, tags: ["checkpoints", "recovery"], confidence: 0.94, sourceEvidence: evidence, impactSummary: "Preserve progress across reconnects.", version: 3, approved: true, createdByPodId: "retry-demo"),
        MemoryEntry(id: "setup-note", scope: .repository, scopeId: "acme/autopod", repositorySetupId: "node-workspace", path: "/testing/setup.md", content: "Run pnpm install before validation.", rationale: "Original workspace setup guidance.", kind: .dependency, tags: ["setup", "review"], confidence: 0.84, sourceEvidence: evidence, version: 2, approved: true, createdByPodId: "setup-demo"),
        MemoryEntry(id: "contrast-note", scope: .repository, scopeId: "acme/console", path: "/accessibility/contrast.md", content: "Check foreground contrast in both dark and light appearances, including focus indicators.", kind: .convention, tags: ["accessibility"], approved: true),
        MemoryEntry(id: "legacy-suggestion", scope: .global, path: "/conventions/commits.md", content: "Use a concise imperative subject and describe the behavioral change.", rationale: "Retained suggestion awaiting explicit review.", kind: .convention, approved: false)
    ]
    static let seedCandidates = [MemoryCandidate(id: "retry-candidate", action: .create, targetMemoryId: nil, scope: .repository, scopeId: "acme/autopod", repositorySetupId: "node-workspace", path: "/checkpoints/retry.md", content: "Restore the saved checkpoint before retrying a reconnect. Keep downloaded artifacts and their verified digests. Retry only the unfinished handoff.", rationale: "Three reconnect attempts repeated an already completed download.", kind: .workflow, tags: ["reconnect", "resilience"], appliesWhen: "Resuming an interrupted handoff", avoidWhen: "Starting a new task without a checkpoint", confidence: 0.92, sourceEvidence: evidence, impactSummary: "Avoid duplicate downloads and preserve progress.", status: .pending, createdByPodId: "retry-demo", fallbackReason: nil, createdAt: "2026-10-17T10:00:00Z", updatedAt: "2026-10-17T10:00:00Z")]
    static let attempts = [MemoryExtractionAttempt(id: "extract-retry", podId: "retry-demo", profileName: "Backend delivery", status: .candidateCreated, reason: "candidate_created", signals: ["verified recovery"], candidateId: "retry-candidate"), MemoryExtractionAttempt(id: "extract-docs", podId: "docs-demo", profileName: "Documentation", status: .noCandidate, reason: "reviewer_decided_no_lesson"), MemoryExtractionAttempt(id: "extract-failed", podId: "setup-demo", profileName: "Backend delivery", status: .reviewerFailed, reason: "reviewer request failed")]
    static func usage(_ id: String) -> [MemoryUsageEvent] {
        let json = """
        [{"id":"usage-1","memoryId":"\(id)","podId":"retry-demo","kind":"read","outcome":"applied","reason":"Verified the saved checkpoint before resuming.","createdAt":"2026-10-17T10:00:00Z"},{"id":"usage-2","memoryId":"\(id)","podId":"setup-demo","kind":"read","outcome":"harmful_stale","reason":"The documented command is unavailable; pnpm is not globally installed.","createdAt":"2026-10-17T09:00:00Z"}]
        """
        return decode([MemoryUsageEvent].self, Data(json.utf8))
    }
    var actions: MemoryWorkspaceActions {
        MemoryWorkspaceActions(create: { scope, scopeID, path, content in
            try self.checkWrite(); self.entries.insert(MemoryEntry(id: UUID().uuidString, scope: scope, scopeId: scopeID, path: path, content: content, approved: true), at: 0)
        }, update: { id, content in
            try self.checkWrite()
            guard let index = self.entries.firstIndex(where: { $0.id == id }) else { throw DaemonError.notFound("Fixture entry no longer exists.") }
            self.entries[index] = Self.copy(self.entries[index], content: content)
        }, updateCandidate: { id, update in
            try self.checkWrite()
            guard let index = self.candidates.firstIndex(where: { $0.id == id }) else { throw DaemonError.notFound("Fixture entry no longer exists.") }
            let old = self.candidates[index]
            self.candidates[index] = MemoryCandidate(id: old.id, action: old.action, targetMemoryId: old.targetMemoryId, scope: old.scope, scopeId: old.scopeId, repositorySetupId: old.repositorySetupId, path: update.path ?? old.path, content: update.content ?? old.content, rationale: update.rationale, kind: old.kind, tags: old.tags, appliesWhen: update.appliesWhen, avoidWhen: update.avoidWhen, confidence: old.confidence, sourceEvidence: old.sourceEvidence, impactSummary: update.impactSummary ?? old.impactSummary, status: .pending, createdByPodId: old.createdByPodId, fallbackReason: old.fallbackReason, createdAt: old.createdAt, updatedAt: old.updatedAt)
        })
    }
    private func checkWrite() throws { if failWrites { throw DaemonError.badRequest("Fictional save failure. Your draft is retained; disable the fixture failure and retry.") } }
    func approve(_ id: String) { if let index = entries.firstIndex(where: { $0.id == id }) { entries[index] = Self.copy(entries[index], approved: true) } }
    func approveCandidate(_ id: String) {
        guard let item = candidates.first(where: { $0.id == id }) else { return }
        entries.append(MemoryEntry(id: "approved-" + id, scope: item.scope, scopeId: item.scopeId, repositorySetupId: item.repositorySetupId, path: item.path, content: item.content, rationale: item.rationale, kind: item.kind, tags: item.tags, appliesWhen: item.appliesWhen, avoidWhen: item.avoidWhen, confidence: item.confidence, sourceEvidence: item.sourceEvidence, impactSummary: item.impactSummary, approved: true, createdByPodId: item.createdByPodId))
        candidates.removeAll { $0.id == id }
    }
    private static func copy(_ item: MemoryEntry, content: String? = nil, approved: Bool? = nil) -> MemoryEntry {
        MemoryEntry(id: item.id, scope: item.scope, scopeId: item.scopeId, repositorySetupId: item.repositorySetupId, path: item.path, content: content ?? item.content, rationale: item.rationale, kind: item.kind, tags: item.tags, appliesWhen: item.appliesWhen, avoidWhen: item.avoidWhen, confidence: item.confidence, sourceEvidence: item.sourceEvidence, impactSummary: item.impactSummary, version: item.version + (content == nil ? 0 : 1), approved: approved ?? item.approved, createdByPodId: item.createdByPodId, createdBySessionId: item.createdBySessionId)
    }
    nonisolated static func decode<T: Decodable>(_ type: T.Type, _ data: Data) -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { preconditionFailure("Invalid knowledge fixture: \(error)") }
    }
    nonisolated static var summary: [String: Any] { ["podId":"managed-recovery-demo", "dispatcherAttemptId":"attempt-demo-0187", "state":"validated", "validationStatus":"passed", "providerAccountId":"fixture-account", "model":"Fixture model", "runtime":"Codex", "executionTarget":"hosted", "reasoning":"high", "profileId":"backend-delivery", "profileVersion":12, "providerRequests":24, "consumedTokens":48120, "tokenUsageKnown":true, "limitations":["Repository identity is not reported."], "artifacts":[["artifactId":"artifact-demo", "status":"committed", "fileCount":5, "totalBytes":6292000, "committedAt":1792233720]], "revoked":false, "stopRequested":false, "observedExit":true, "cleanup":"complete", "exitCode":0, "createdAt":1792233120, "lastEventAt":1792233720] }
    nonisolated static var summaryObjects: [[String: Any]] {
        var running = summary
        running["podId"] = "managed-running-demo"; running["dispatcherAttemptId"] = "attempt-demo-0188"
        running["state"] = "running"; running["validationStatus"] = "not_requested"; running["profileId"] = "frontend-craft"
        running["tokenUsageKnown"] = false; running["observedExit"] = false; running["exitCode"] = NSNull(); running["cleanup"] = "pending"; running["artifacts"] = []
        var failed = summary
        failed["podId"] = "managed-failure-demo"; failed["dispatcherAttemptId"] = "attempt-demo-0189"
        failed["state"] = "failed"; failed["validationStatus"] = "not_requested"; failed["exitCode"] = 1; failed["artifacts"] = []
        failed["failure"] = ["phase":"provider_request", "reason":"The fictional provider account reached its request limit.", "httpStatus":429]
        return [summary, running, failed]
    }
    nonisolated static func detailData(_ id: String = "managed-recovery-demo") throws -> Data {
        guard let selected = summaryObjects.first(where: { $0["podId"] as? String == id }) else { throw URLError(.fileDoesNotExist) }
        let data = try JSONSerialization.data(withJSONObject: ["pod":selected, "validations":[["validationId":"validation-demo", "mode":"local", "status":"passed", "newCommit":"ad8b4216", "reason":"Requested checks completed.", "receiptDigest":"sha256:fixture-receipt", "phases":[["phase":"lint","status":"passed","durationMs":1800],["phase":"build","status":"passed","durationMs":7200],["phase":"test","status":"passed","durationMs":12400]]]], "candidates":[["candidateId":"candidate-head-demo","newCommit":"ad8b4216"]], "source":[["operationKey":"source-demo", "operation":"draft_pull_request", "head":"ad8b4216", "status":"complete", "pullRequestId":142]], "verification":["status":"verified"], "events":[["eventId":"event-demo-2","kind":"artifact_committed","createdAt":1792233720],["eventId":"event-demo-1","kind":"validation_receipt","createdAt":1792233660]]])
        if id == "managed-recovery-demo" { return data }
        return try JSONSerialization.data(withJSONObject: ["pod":selected, "validations":[], "candidates":[], "source":[], "events":[], "verification":NSNull()])
    }
    static var managedPods: [ManagedPodSummary] { decode([ManagedPodSummary].self, try! JSONSerialization.data(withJSONObject: summaryObjects)) }
    nonisolated static let fileContents = ["summary.md":"# Recovery without repeated work\n\nCheckpoint restoration retains verified artifacts and resumes the unfinished handoff.\n\n- Restore the checkpoint first\n- Keep verified downloads\n- Repeat completed steps safely\n", "report.html":"<h1>Recovery validation</h1><p>All three recorded checks passed against ad8b4216.</p>", "results.json":"{\"status\":\"passed\",\"artifacts\":3}", "trace.bin":"binary"]
    nonisolated static func manifestData() throws -> Data {
        var files = fileContents.keys.sorted().map { path -> [String: Any] in
            let data = Data(fileContents[path]!.utf8)
            return ["path":path, "size":data.count, "sha256":"sha256:" + SHA256.hash(data: data).map { String(format:"%02x",$0) }.joined(), "mediaType":path.hasSuffix(".md") ? "text/markdown" : path.hasSuffix(".html") ? "text/html" : path.hasSuffix(".json") ? "application/json" : "application/octet-stream"]
        }
        files.append(["path":"large.log", "size":6 * 1024 * 1024, "sha256":"sha256:fixture-oversized", "mediaType":"text/plain"])
        return try JSONSerialization.data(withJSONObject: ["files":files,"bundle":["format":"tar.gz","size":4096,"sha256":"sha256:fixture-bundle-identity"]])
    }
    nonisolated static func makeAPI(integrityFailure: Bool = false) -> DaemonAPI {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [KnowledgePreviewProtocol.self]
        return DaemonAPI(baseURL: URL(string: integrityFailure ? "https://knowledge-integrity-preview.invalid" : "https://knowledge-preview.invalid")!, token:"fictional-preview", session:URLSession(configuration:config))
    }
}

private final class KnowledgePreviewProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { ["knowledge-preview.invalid", "knowledge-integrity-preview.invalid"].contains(request.url?.host ?? "") }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let url = request.url else { throw URLError(.badURL) }
            let data: Data
            if url.path.hasPrefix("/managed/pods/") { data = try DesktopKnowledgeFixtures.detailData(url.lastPathComponent) }
            else if url.path.hasSuffix("/manifest") { data = try DesktopKnowledgeFixtures.manifestData() }
            else if url.path.hasSuffix("/files/content") {
                let path = URLComponents(url:url, resolvingAgainstBaseURL:false)?.queryItems?.first { $0.name == "path" }?.value ?? ""
                guard let text = DesktopKnowledgeFixtures.fileContents[path] else { throw URLError(.fileDoesNotExist) }; data = Data((url.host == "knowledge-integrity-preview.invalid" ? "tampered fixture bytes" : text).utf8)
            } else { throw URLError(.unsupportedURL) }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url:url,statusCode:200,httpVersion:nil,headerFields:nil)!, cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self, didLoad:data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError:error) }
    }
    override func stopLoading() {}
}
