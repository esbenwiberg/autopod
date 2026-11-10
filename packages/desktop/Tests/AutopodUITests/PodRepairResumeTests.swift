import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct PodRepairResumeTests {
  @Test(arguments: ["accepted", "rejected", "uncertain"])
  func resumeDismissesOnlyAfterAnAcceptedReceipt(outcome: String) async throws {
    let fixture = ResumeHandoffFixture()
    let model = PodRepairModel(kind: .resume, scope: "resume-fixture", ordinaryRework: true)
    var actions = PodActions()
    actions.repair = PodRepairActions(scope: "resume-fixture", submit: { _, kind, _ in
      #expect(kind == .resume)
      fixture.submissions += 1
      await withCheckedContinuation { fixture.pending = $0 }
      if outcome == "rejected" { throw DaemonError.serverError(409, "Recovery blocked") }
      if outcome == "uncertain" { throw DaemonError.networkError("The request timed out.") }
      return PodRepairReceipt(message: "Recovery accepted; validation is still running.")
    }, inspect: { _ in PodRepairObservation(source: fixture.pod, related: []) })
    let eligibility = try JSONDecoder().decode(ReworkEligibility.self,
      from: Data(#"{"eligible":true,"status":"eligible","reason":"Current lifecycle eligible","generation":1}"#.utf8))
    actions.repair.loadReworkEligibility = { _ in eligibility }
    let host = LaunchComposerHost(PodRepairSheet(
      isPresented: Binding(get: { fixture.presented }, set: { fixture.presented = $0 }),
      pod: fixture.pod, kind: .resume, relatedPods: [], actions: actions, model: model), width: 1120)
    defer { fixture.release(); host.close() }
    try await host.wait { host.enabled("repair-submit") }
    try host.press("repair-submit")
    try await host.wait { fixture.pending != nil }
    #expect(model.busy && fixture.presented && model.receipt == nil)
    // Model state precedes SwiftUI's accessibility update; keep the receipt pending.
    try await host.wait { host.has("repair-submit") && !host.enabled("repair-submit") }
    #expect(!host.enabled("repair-submit"))
    fixture.release()
    try await host.wait { !model.busy }
    if outcome == "accepted" {
      try await host.wait { !fixture.presented }
      #expect(model.receipt != nil && !model.uncertain)
    } else {
      #expect(fixture.presented && model.receipt == nil && model.error != nil)
      #expect(model.uncertain == (outcome == "uncertain"))
      if outcome == "uncertain" {
        try await host.wait { host.enabled("repair-inspect") }
        #expect(!host.has("repair-submit"))
        await model.submit(id: fixture.pod.id, actions: actions.repair)
      }
    }
    #expect(fixture.submissions == 1)
  }
}

@MainActor private final class ResumeHandoffFixture {
  var presented = true
  var submissions = 0
  var pending: CheckedContinuation<Void, Never>?
  var pod: Pod {
    Pod(id: "resume-fixture", status: .failed, hasWorktree: true, branch: "recovery",
      profileName: "fixture", task: "Resume delivery", model: "fixture", startedAt: .now)
  }
  func release() {
    pending?.resume()
    pending = nil
  }
}
