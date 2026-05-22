import Testing
@testable import AutopodUI

@Test func diffExpansionPrunerBuildsStableFileKeys() {
  let key = DiffExpansionPruner.fileKey(commitSha: "abc123", fileId: "abc123:src/app.ts")

  #expect(key == "abc123:abc123:src/app.ts")
}

@Test func diffExpansionPrunerDropsStaleCommitAndFileKeys() {
  let keptFile = DiffExpansionPruner.fileKey(commitSha: "commit-a", fileId: "commit-a:src/a.ts")
  let removedCommitFile = DiffExpansionPruner.fileKey(
    commitSha: "commit-b",
    fileId: "commit-b:src/b.ts"
  )
  let removedFile = DiffExpansionPruner.fileKey(
    commitSha: "commit-a",
    fileId: "commit-a:src/removed.ts"
  )

  let pruned = DiffExpansionPruner.prune(
    expandedCommits: ["commit-a", "commit-b"],
    expandedCommitFiles: [keptFile, removedCommitFile, removedFile],
    validCommitShas: ["commit-a"],
    validFileIdsByCommitSha: ["commit-a": ["commit-a:src/a.ts"]]
  )

  #expect(pruned.expandedCommits == ["commit-a"])
  #expect(pruned.expandedCommitFiles == [keptFile])
}
