import Foundation
import Testing
@testable import AutopodClient

private func savedDraftReceipt(repository: String, url: String) throws -> SavedWorkDraftOperation {
  let sha = String(repeating: "a", count: 40)
  let branch = "autopod/saved-work/task/operation"
  let object: [String: Any] = [
    "id": "operation", "requestId": "request", "podId": "task", "actorId": "human", "generation": 1,
    "previewBinding": "preview", "confirmationBinding": "confirmation", "repository": repository,
    "baseBranch": "main", "branch": branch, "checks": "NOT RUN", "body": "Original retained",
    "createdAt": "now", "expiresAt": "later", "state": "published",
    "source": ["id": "local", "kind": "local-commit", "commit": sha, "tree": sha,
      "ref": "refs/heads/source", "freshness": "host-commit-only", "exclusions": "Unsaved work excluded"],
    "receipt": ["url": url, "draft": true, "head": sha, "branch": branch, "baseBranch": "main"],
  ]
  return try JSONDecoder().decode(SavedWorkDraftOperation.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test(arguments: ["https://github.com/ORG/Repo", "https://github.com/org/repo/", "https://github.com/ORG/Repo.git/"])
func savedDraftLinkNormalizesGitHubRepository(repository: String) throws {
  let url = "https://github.com/org/repo/pull/9"
  #expect(try savedDraftReceipt(repository: repository, url: url).safeDraftURL?.absoluteString == url)
}

@Test(arguments: ["https://dev.azure.com/org/project/_git/repo/", "https://org.visualstudio.com/project/_git/repo"])
func savedDraftLinkNormalizesAdoRepository(repository: String) throws {
  let url = "https://dev.azure.com/org/project/_git/repo/pullrequest/9"
  #expect(try savedDraftReceipt(repository: repository, url: url).safeDraftURL?.absoluteString == url)
}

@Test(arguments: ["https://github.com/other/repo/pull/9", "https://github.com/org/repository/pull/9",
  "https://github.com/org/repo/issues/9", "https://github.com/org/repo/pull/9?redirect=other",
  "https://evil.invalid/org/repo/pull/9", "https://github.com/org/repo/pull/0"])
func savedDraftLinkRefusesNonMatchingPr(url: String) throws {
  #expect(try savedDraftReceipt(repository: "https://github.com/org/repo", url: url).safeDraftURL == nil)
}
