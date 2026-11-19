import AppKit
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct OverviewFailureReportingTests {
  let saved = "  first line\n" + String(repeating: "detail ", count: 90) + "\nTAIL-SENTINEL \t\n"

  @Test func copyUsesExactFullSavedTextAndAbsentDetailDoesNotCopy() {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let detail = FailureDetail(podID: "residential-cod", updatedAt: .distantPast, status: .failed, reason: saved)
    let view = OverviewFailureReason(detail: detail)
    #expect(view.clipboardPayload == saved)
    view.copyReason(to: board)
    #expect(board.string(forType: .string) == saved)
    for missing in [nil, FailureDetail(podID: "residential-cod", updatedAt: .distantPast, status: .failed, reason: nil)] {
      let absent = OverviewFailureReason(detail: missing)
      #expect(absent.clipboardPayload == nil)
      absent.copyReason(to: board)
      #expect(board.string(forType: .string) == saved)
    }
  }

  @Test func narrowDisclosureShowsTailAndLabelledCopyControl() async throws {
    let detail = FailureDetail(podID: "residential-cod", updatedAt: .distantPast, status: .failed, reason: saved)
    let host = LaunchComposerHost(ScrollView { OverviewFailureReason(detail: detail) }, width: 320)
    defer { host.close() }
    try await host.wait { host.has("overview-copy-reason") && host.has("overview-recorded-reason") }
    #expect(host.containsText("TAIL-SENTINEL"))
    #expect(host.containsText("Copy reason"))
    // SwiftUI's enabled text selection exposes native selectable text to accessibility.
    let text = try #require(host.matches("overview-recorded-reason").first)
    #expect(text.responds(to: NSSelectorFromString("accessibilitySelectedText")))
  }

  @Test func pendingAndConfirmedAbsenceHaveDistinctMessagesAndNoCopy() async throws {
    for detail in [nil, FailureDetail(podID: "residential-cod", updatedAt: .distantPast, status: .killed, reason: nil)] {
      let host = LaunchComposerHost(OverviewFailureReason(detail: detail), width: 320)
      defer { host.close() }
      let expected = detail == nil ? "pending or unavailable" : "No reason was recorded"
      try await host.wait { host.containsText(expected) }
      #expect(!host.has("overview-copy-reason"))
    }
  }

  @Test func warningPrecedenceAndNeutralKilledProjection() {
    var pod = Pod(id: "residential-cod", status: .failed, branch: "fixture", profileName: "fixture", model: "fixture", startedAt: .distantPast, updatedAt: .distantPast)
    pod.failureDetail = FailureDetail(podID: pod.id, updatedAt: pod.updatedAt, status: pod.status, reason: saved, validationTitle: "Test failed")
    pod.linkedSessionId = "parent"
    pod.latestActivity = "Validated fix could not be pushed: remote unavailable"
    #expect(pod.failureWarningTitle == "Fix validated, push failed")
    pod.worktreeCompromised = true
    #expect(pod.failureWarningTitle == "Worktree needs recovery")
    pod.status = .running
    pod.executionRecoveryNote = "Inspect execution"
    pod.errorSummary = "unknown execution"
    #expect(pod.failureWarningTitle == "Execution requires recovery inspection")
    pod.status = .killed
    #expect(pod.failureOverviewTitle == nil)
    #expect(pod.recordedFailureReason == nil)
  }
}
