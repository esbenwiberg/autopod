import AppKit
import Observation
import SwiftUI
import Testing
@testable import AutopodUI

private struct FleetWidthProbe: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = NSUserInterfaceItemIdentifier("fleet-width-probe")
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {}
}

@MainActor @Observable private final class FleetLayoutInputs {
    var showsDetails = true
    var isFleet = true
}

@MainActor private struct FleetLayoutFixture: View {
    let inputs: FleetLayoutInputs
    var body: some View {
        DesktopPodNavigationLayout(isFleet: inputs.isFleet, showsDetails: inputs.showsDetails) {
            Text("Sidebar").navigationSplitViewColumnWidth(180)
        } fleet: {
            FleetWidthProbe().frame(minWidth: 420)
        } detail: {
            Text("Native detail marker").frame(minWidth: 350, maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

@Suite(.serialized) @MainActor struct DesktopPodNavigationLayoutTests {
    @Test func closingRemovesSplitItemAndExpandsFleetAtConstrainedWidth() async throws {
        let inputs = FleetLayoutInputs()
        let host = LaunchComposerHost(FleetLayoutFixture(inputs: inputs), width: 1_100)
        defer { host.close() }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        func width() -> CGFloat {
            host.window.layoutIfNeeded()
            host.hosting.layoutSubtreeIfNeeded()
            return descendants(host.hosting).first {
                $0.identifier?.rawValue == "fleet-width-probe"
            }?.bounds.width ?? 0
        }
        try await host.wait { width() > 0 && host.containsText("Native detail marker") }
        let initialWidth = width()
        let windowFrame = host.window.frame
        inputs.showsDetails = false
        try await host.wait { !host.containsText("Native detail marker") && width() > initialWidth + 300 }
        #expect(host.window.frame == windowFrame)
        let expandedWidth = width()
        inputs.showsDetails = true
        try await host.wait { host.containsText("Native detail marker") && width() < expandedWidth - 300 }
        #expect(host.window.frame == windowFrame)
        try host.capture("fleet-details-reopened-1100")
        inputs.showsDetails = false
        try await host.wait { width() > initialWidth + 300 }
        try host.capture("fleet-details-closed-1100")
    }

    @Test func nonFleetDetailIsIndependentOfFleetDismissal() async throws {
        let inputs = FleetLayoutInputs()
        inputs.isFleet = false
        inputs.showsDetails = false
        let host = LaunchComposerHost(FleetLayoutFixture(inputs: inputs), width: 1_200)
        defer { host.close() }
        try await host.wait { host.containsText("Native detail marker") }
    }

    @Test func hiddenSidebarStaysHiddenAcrossDetailDismissal() async throws {
        let inputs = FleetLayoutInputs()
        let host = LaunchComposerHost(FleetLayoutFixture(inputs: inputs), width: 1_100)
        defer { host.close() }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        try await host.wait { host.containsText("Native detail marker") }
        let controller = try #require(descendants(host.hosting).compactMap { view in
            (view as? NSSplitView)?.delegate as? NSSplitViewController
        }.first { $0.splitViewItems.first?.behavior == .sidebar })
        let sidebar = try #require(controller.splitViewItems.first)
        controller.toggleSidebar(nil)
        try await host.wait { sidebar.isCollapsed }
        inputs.showsDetails = false
        try await host.wait { !host.containsText("Native detail marker") }
        #expect(sidebar.isCollapsed)
        inputs.showsDetails = true
        try await host.wait { host.containsText("Native detail marker") }
        #expect(sidebar.isCollapsed)
    }
}
