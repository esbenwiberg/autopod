import Foundation
import Testing
import AutopodClient
@testable import AutopodDesktop

@Suite(.serialized) struct MemoryDraftSaveTests {
    @MainActor @Test func failedUpdateReportsFailureAndRetryPreservesIdentityAndProvenance() async throws {
        let store = MemoryStore()
        let original = MemoryEntry(id: "mem", scope: .repository, scopeId: "repo", repositorySetupId: "setup", path: "/notes.md", content: "before", rationale: "why", kind: .workflow, tags: ["retain"], confidence: 0.9, sourceEvidence: DesktopKnowledgeFixtures.evidence, version: 3, approved: true, createdByPodId: "source-pod", createdBySessionId: "source-session")
        store.handleSuggestionCreated(original); store.configure(api: api())
        MemoryDraftProtocol.handler = { request in (500, Data(#"{"message":"save failed"}"#.utf8)) }
        defer { MemoryDraftProtocol.handler = nil }
        let failed = await store.update("mem", content: "after")
        #expect(!failed); #expect(store.entries.first?.content == "before"); #expect(store.entries.first?.version == 3)
        #expect(store.error != nil)
        MemoryDraftProtocol.handler = { request in
            #expect(request.httpMethod == "PATCH"); #expect(request.url?.path == "/memory/mem")
            return (200, Data("{}".utf8))
        }
        let saved = await store.update("mem", content: "after")
        #expect(saved); #expect(store.error == nil)
        let value = try #require(store.activeMemories.first)
        #expect(value.content == "after"); #expect(value.version == 4)
        #expect(value.scope == .repository); #expect(value.scopeId == "repo"); #expect(value.repositorySetupId == "setup")
        #expect(value.path == "/notes.md"); #expect(value.createdByPodId == "source-pod"); #expect(value.createdBySessionId == "source-session")
        #expect(value.sourceEvidence == original.sourceEvidence); #expect(value.tags == ["retain"])
    }
    @MainActor @Test func createAndCandidateEditsReportDisconnectedAndServerFailures() async throws {
        let store = MemoryStore()
        let disconnected = await store.create(scope: .global, scopeId: nil, path: "/new.md", content: "new")
        #expect(!disconnected); #expect(store.entries.isEmpty); #expect(store.error != nil)
        store.configure(api: api())
        let candidate = try #require(DesktopKnowledgeFixtures.seedCandidates.first)
        store.handleCandidateCreated(candidate)
        MemoryDraftProtocol.handler = { _ in (500, Data("{}".utf8)) }
        defer { MemoryDraftProtocol.handler = nil }
        let candidateFailed = await store.updateCandidate(candidate.id, updates: MemoryCandidateUpdate(content: "edited"))
        #expect(!candidateFailed); #expect(store.pendingCandidates.first?.content == candidate.content)
        let created = MemoryEntry(id: "manual", scope: .global, path: "/new.md", content: "new", approved: true)
        let data = try JSONEncoder().encode(created)
        MemoryDraftProtocol.handler = { request in
            #expect(request.httpMethod == "POST"); #expect(request.url?.path == "/memory")
            return (200, data)
        }
        let saved = await store.create(scope: .global, scopeId: nil, path: "/new.md", content: "new")
        #expect(saved); #expect(store.error == nil); #expect(store.activeMemories.first?.approved == true)
    }
    private func api() -> DaemonAPI {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [MemoryDraftProtocol.self]
        return DaemonAPI(baseURL: URL(string: "https://memory-test.invalid")!, token: "test", session: URLSession(configuration: configuration))
    }
}
private final class MemoryDraftProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "memory-test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler, let url = request.url else { throw URLError(.unsupportedURL) }
            let (code, data) = try handler(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: code, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
