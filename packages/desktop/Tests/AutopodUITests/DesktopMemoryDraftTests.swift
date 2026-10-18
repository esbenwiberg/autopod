import Testing
import AutopodClient
@testable import AutopodUI

@MainActor @Test func newMemoryRequiresScopeIdentityExceptForGlobal() {
    var draft = DesktopMemoryDraft(); draft.path = "/notes/test.md"; draft.content = "Remember this."
    #expect(draft.isValid)
    for scope in [MemoryScope.repository, .profile, .pod, .unknown("future")] {
        draft.scope = scope; draft.scopeID = "   "
        #expect(!draft.isValid)
        draft.scopeID = "repo-or-pod-id"; #expect(draft.isValid)
    }
    draft.content = "\n \t"; #expect(!draft.isValid)
}

@MainActor @Test func candidateDraftChangesContentWhilePreservingReviewerMetadata() throws {
    let source = MemorySourceEvidence(podId: "origin", signal: "test", excerpt: "failed setup", severity: .high)
    let candidate = MemoryCandidate(id: "candidate", action: .update, targetMemoryId: "target", scope: .repository, scopeId: "repo", path: "/old.md", content: "old", rationale: "old rationale", kind: .gotcha, tags: ["keep"], appliesWhen: nil, avoidWhen: nil, confidence: 0.91, sourceEvidence: [source], impactSummary: "old impact", status: .pending, createdByPodId: "origin", fallbackReason: nil, createdAt: "", updatedAt: "")
    var draft = DesktopMemoryDraft(candidate: candidate)
    draft.path = " /new.md "; draft.content = "new"; draft.rationale = "  new rationale  "
    draft.appliesWhen = " after reconnect "; draft.avoidWhen = "   "; draft.impact = " new impact "
    let update = try #require(draft.candidateUpdate)
    #expect(update.path == "/new.md"); #expect(update.content == "new")
    #expect(update.rationale == "new rationale"); #expect(update.appliesWhen == "after reconnect"); #expect(update.avoidWhen == nil)
    #expect(update.impactSummary == "new impact")
    #expect(update.kind == .gotcha); #expect(update.tags == ["keep"])
    #expect(update.confidence == 0.91); #expect(update.sourceEvidence == [source])
    #expect(draft.candidate?.targetMemoryId == "target")
    #expect(draft != DesktopMemoryDraft(candidate: candidate))
}
