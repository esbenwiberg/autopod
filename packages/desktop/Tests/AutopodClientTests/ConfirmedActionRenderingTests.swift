import AppKit
import SwiftUI
import Testing
import AutopodDesktop
import AutopodUI

/// Production detail composition, not application startup or button-activation proof.
@MainActor @Test(arguments: ConfirmedAction.allCases, ["rejected", "confirmed", "late-failure"])
func confirmedActionRendersObservedState(action: ConfirmedAction, outcome: String) async throws {
  try await withConfirmedActionFixture { fixture in
    let rendered = ConfirmedActionRenderProbe()
    let hosting = NSHostingView(rootView: ConfirmedActionDetailHost(fixture: fixture, rendered: rendered))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 760),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.appearance = NSAppearance(named: .darkAqua)
    defer {
      window.contentView = nil
      window.close()
    }
    let prefix = action.rawValue
    try await captureConfirmedAction(hosting, rendered: rendered, status: .running,
      name: outcome == "rejected" ? "\(prefix)-initial" : nil)
    let task = fixture.start(action)
    let post = try await fixture.next("POST", action: action)
    fixture.expectState(.running)
    try await captureConfirmedAction(hosting, rendered: rendered, status: .running,
      name: outcome == "rejected" ? "\(prefix)-held" : nil)
    switch outcome {
    case "confirmed":
      post.respond(body: #"{"ok":true}"#)
      let get = try await fixture.next("GET")
      fixture.expectState(.running)
      let status: PodStatus = action == .pause ? .paused : .killed
      get.respond(body: fixture.snapshot(status: status))
      await task.value
      fixture.expectState(status)
      try await captureConfirmedAction(hosting, rendered: rendered, status: status, name: "\(prefix)-confirmed")
    case "late-failure":
      fixture.store.updateStatus(fixture.id, to: .complete)
      try await captureConfirmedAction(hosting, rendered: rendered, status: .complete, name: "\(prefix)-newer-event")
      post.respond(status: 409, body: #"{"error":"Fixture rejected action"}"#)
      await task.value
      fixture.expectState(.complete)
      try await captureConfirmedAction(hosting, rendered: rendered, status: .complete, name: "\(prefix)-late-failure")
    default:
      post.respond(status: 409, body: #"{"error":"Fixture rejected action"}"#)
      await task.value
      fixture.expectState(.running)
      try await captureConfirmedAction(hosting, rendered: rendered, status: .running, name: "\(prefix)-rejected")
    }
    #expect(fixture.handler.pendingAction == nil)
    #expect((fixture.handler.lastError != nil) == (outcome != "confirmed"))
    #expect(fixture.peer.requests.count == (outcome == "confirmed" ? 2 : 1))
  }
}

@MainActor private final class ConfirmedActionRenderProbe {
  var status: PodStatus?
}

@MainActor private struct ConfirmedActionDetailHost: View {
  let fixture: ConfirmedActionFixture
  let rendered: ConfirmedActionRenderProbe
  @State private var selectedTab: DetailTab? = .overview

  var body: some View {
    if let pod = fixture.store.selectedSession {
      DetailPanelView(pod: pod, events: [], actions: fixture.handler.actions, selectedTab: $selectedTab)
        .onAppear { rendered.status = pod.status }
        .onChange(of: pod.status) { _, status in rendered.status = status }
    }
  }
}

@MainActor private func captureConfirmedAction(
  _ hosting: NSHostingView<ConfirmedActionDetailHost>,
  rendered: ConfirmedActionRenderProbe,
  status: PodStatus,
  name: String?
) async throws {
  // Await this production view's onAppear/onChange, not a fixed rendering sleep.
  let deadline = ContinuousClock.now.advanced(by: .seconds(5))
  repeat {
    hosting.window?.layoutIfNeeded()
    hosting.layoutSubtreeIfNeeded()
    if rendered.status == status { break }
    guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
    await Task.yield()
  } while true
  #expect(rendered.status == status)
  #expect(hosting.fittingSize.width <= 900)
  #expect(hosting.fittingSize.height <= 760)
  guard let name, let directory = ProcessInfo.processInfo.environment["AUTOPOD_ACTION_RENDER_DIR"] else { return }
  let url = URL(fileURLWithPath: directory, isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
  hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
  let png = try #require(bitmap.representation(using: .png, properties: [:]))
  try png.write(to: url.appendingPathComponent("\(name).png"))
}
