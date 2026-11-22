import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@MainActor
struct ParentBundleHandoffTests {
  @Test func previewDoesNotApproveOrDownloadAndSaveRequiresExplicitApproval() async throws {
    let f = try Fixture()
    let model = ParentBundleHandoff()
    let permitted: @MainActor @Sendable () -> Bool = { true }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bundle")
    defer { try? FileManager.default.removeItem(at: url) }
    await model.approve(f.selection, actions: f.actions, isCurrent: permitted)
    await model.load(f.selection, actions: f.actions, isCurrent: permitted)
    await model.save(f.selection, actions: f.actions, isCurrent: permitted) { _ in
      Issue.record("Unapproved bundle should not open a save panel")
      return url
    }
    #expect(f.events == ["preview"])
    #expect(model.review == f.review)
    #expect(model.approval == nil)
    await model.approve(f.selection, actions: f.actions, isCurrent: permitted)
    await model.approve(f.selection, actions: f.actions, isCurrent: permitted)
    #expect(f.events == ["preview", "approve"])
    #expect(!FileManager.default.fileExists(atPath: url.path))
    // The Save panel has accepted a replacement, but its old group/world mode must not carry over.
    try Data("old".utf8).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
    await model.save(f.selection, actions: f.actions, isCurrent: permitted) { name in
      #expect(name == "parent-\(f.selection.commit).bundle")
      return url
    }
    #expect(f.events == ["preview", "approve", "download"])
    #expect(try Data(contentsOf: url) == f.bytes)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
  }

  @Test(arguments: ["account", "selection", "closed"])
  func staleApprovalIsNotSent(kind: String) async throws {
    let f = try Fixture()
    let model = ParentBundleHandoff()
    let permitted: @MainActor @Sendable () -> Bool = { f.selectionCurrent }
    await model.load(f.selection, actions: f.actions, isCurrent: permitted)
    f.beforeApprovalSend = {
      switch kind {
      case "account": f.accountCurrent = false
      case "selection": f.selectionCurrent = false
      default: model.close()
      }
    }
    await model.approve(f.selection, actions: f.actions, isCurrent: permitted)
    #expect(f.events == ["preview"])
    #expect(model.approval == nil)
  }

  @Test func approvalCompletedOnOldConnectionDoesNotUnlockSave() async throws {
    let f = try Fixture()
    let model = ParentBundleHandoff()
    await model.load(f.selection, actions: f.actions, isCurrent: { true })
    f.afterApprovalSend = { f.accountCurrent = false }
    await model.approve(f.selection, actions: f.actions, isCurrent: { true })
    #expect(f.events == ["preview", "approve"])
    #expect(model.approval == nil)
    await model.save(f.selection, actions: f.actions, isCurrent: { true }) { _ in
      Issue.record("Stale approval must not prompt for a destination")
      return nil
    }
    #expect(f.events == ["preview", "approve"])
  }

  @Test(arguments: [false, true])
  func accountChangeOrCancelAtSavePanelDoesNotWriteBytes(canceled: Bool) async throws {
    let f = try Fixture()
    let model = ParentBundleHandoff()
    await model.load(f.selection, actions: f.actions, isCurrent: { true })
    await model.approve(f.selection, actions: f.actions, isCurrent: { true })
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bundle")
    defer { try? FileManager.default.removeItem(at: url) }
    await model.save(f.selection, actions: f.actions, isCurrent: { true }) { _ in
      if canceled { return nil }
      f.accountCurrent = false
      return url
    }
    #expect(f.events == ["preview", "approve", "download"])
    #expect(!FileManager.default.fileExists(atPath: url.path))
  }

  @MainActor private final class Fixture {
    var events: [String] = []
    var accountCurrent = true
    var selectionCurrent = true
    var beforeApprovalSend: (() -> Void)?
    var afterApprovalSend: (() -> Void)?
    let selection: ParentBundleSelection
    let review: ParentBundleReview
    let approval: ParentBundleApproval
    let bytes = Data("verified test bundle".utf8)

    init() throws {
      func sha(_ char: String) -> String { "sha256:" + String(repeating: char, count: 64) }
      let commit = String(repeating: "f", count: 40)
      let tree = String(repeating: "a", count: 40)
      selection = try #require(ParentBundleSelection(parentId: "parent", run: "run", evidenceDigest: sha("b"), commit: commit))
      let json = """
        {"parentId":"parent","run":"run","evidenceDigest":"\(sha("b"))","commit":"\(commit)","tree":"\(tree)",
        "bundleDigest":"\(sha("c"))","paths":["sample/count.txt"],"checks":"\(sha("1"))",
        "independentReview":"\(sha("2"))","reviewDigest":"\(sha("d"))"}
        """
      review = try JSONDecoder().decode(ParentBundleReview.self, from: Data(json.utf8))
      approval = try JSONDecoder().decode(ParentBundleApproval.self, from: Data("""
        {"review":\(json),"approvalDigest":"\(sha("e"))","approvedAt":1795375100}
        """.utf8))
    }

    var actions: ParentBundleActions {
      ParentBundleActions(isCurrent: { selection in self.accountCurrent && selection == self.selection }, preview: { selection, check in
        try check()
        #expect(selection == self.selection)
        self.events.append("preview")
        return self.review
      }, approve: { selection, review, check in
        self.beforeApprovalSend?()
        try check()
        #expect(selection == self.selection)
        #expect(review == self.review)
        self.events.append("approve")
        self.afterApprovalSend?()
        return self.approval
      }, download: { selection, receipt, check in
        try check()
        #expect(selection == self.selection)
        #expect(receipt == self.approval)
        self.events.append("download")
        return self.bytes
      })
    }
  }
}
