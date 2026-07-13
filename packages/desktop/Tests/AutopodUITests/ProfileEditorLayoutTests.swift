import AppKit
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Test func profileEditorGeneralSectionDoesNotOverflowSheetWidth() {
    let editor = ProfileEditorView(profile: MockProfiles.myApp, isNew: false)
    let hostingView = NSHostingView(rootView: editor)
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 880, height: 720),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    window.contentView = hostingView
    hostingView.appearance = NSAppearance(named: .darkAqua)
    window.layoutIfNeeded()

    hostingView.layoutSubtreeIfNeeded()

    let overflowingSubviews = hostingView.subviews.filter {
        $0.frame.minX < 0 || $0.frame.maxX > hostingView.bounds.maxX
    }
    #expect(overflowingSubviews.isEmpty)
}
