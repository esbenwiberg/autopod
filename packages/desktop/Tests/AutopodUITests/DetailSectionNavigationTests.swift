import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct DetailSectionNavigationTests {
  @Test(arguments: [680.0, 1400.0], [false, true])
  func workAndEvidenceUseLeftNavigation(width: Double, light: Bool) async throws {
    let pod = fixturePod
    let work = LaunchComposerHost(
      DetailPanelView(pod: pod, events: [], selectedTab: .constant(.work)), width: width, light: light)
    defer { work.close() }
    try await work.wait { work.has("work-section-plan") }
    let task = try frame(work, "work-section-task")
    let plan = try frame(work, "work-section-plan")
    #expect(abs(task.minX - plan.minX) < 1)
    #expect(abs(task.minY - plan.minY) > 10)
    try work.press("work-section-plan")
    try await work.wait { work.containsText("No plan reported yet") }
    try work.capture("detail-work-left-\(Int(width))-\(light ? "light" : "dark")")
    let evidence = LaunchComposerHost(
      DetailPanelView(pod: pod, events: [], selectedTab: .constant(.evidence)), width: width, light: light)
    defer { evidence.close() }
    try await evidence.wait { evidence.has("evidence-section-markdown") }
    let screenshots = try frame(evidence, "evidence-section-screenshots")
    let artifacts = try frame(evidence, "evidence-section-artifacts")
    #expect(abs(screenshots.minX - artifacts.minX) < 1)
    #expect(abs(screenshots.minY - artifacts.minY) > 10)
    try evidence.press("evidence-section-artifacts")
    try await evidence.wait { evidence.containsText("Show all files") }
    try evidence.press("evidence-section-screenshots")
    try await evidence.wait { evidence.containsText("Proof of Work") }
    try evidence.capture("detail-evidence-left-\(Int(width))-\(light ? "light" : "dark")")
  }

  @Test(arguments: [680.0, 1400.0], [false, true])
  func validationCardsAreHorizontalAndSelectRealPhaseDetails(width: Double, light: Bool) async throws {
    let host = LaunchComposerHost(
      DetailPanelView(pod: fixturePod, events: [], selectedTab: .constant(.validation)), width: width, light: light)
    defer { host.close() }
    try await host.wait { host.has("validation-phase-setup") }
    #expect(host.matches("validation-phase-setup").count == 1)
    let setup = try frame(host, "validation-phase-setup")
    let lint = try frame(host, "validation-phase-lint")
    #expect(abs(setup.minY - lint.minY) < 1)
    #expect(lint.minX > setup.maxX)
    #expect(setup.height > 60)
    try host.press("validation-phase-build")
    try await host.wait { host.containsText("Build succeeded") }
    try host.press("validation-phase-review")
    try await host.wait { host.containsText("Review fixture result") }
    try host.capture("detail-validation-cards-\(Int(width))-\(light ? "light" : "dark")")
  }

  private var fixturePod: Pod {
    Pod(id: "layout-review", status: .validated, branch: "fix/reconnect-retry", profileName: "backend",
      task: "Fix retry behaviour on reconnect", model: "Codex", startedAt: Date(),
      validationChecks: ValidationChecks(smoke: true, setup: true, build: true, tests: true,
        lint: true, sast: true, review: true, reviewReasoning: "Review fixture result", validationSuite: "full"))
  }
  private func frame(_ host: LaunchComposerHost, _ id: String) throws -> CGRect {
    let node = try #require(host.matches(id).first { $0.responds(to: NSSelectorFromString("accessibilityFrame")) })
    return try #require(node.value(forKey: "accessibilityFrame") as? NSValue).rectValue
  }
}
