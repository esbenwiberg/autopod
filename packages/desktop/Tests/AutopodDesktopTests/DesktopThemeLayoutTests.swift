import AppKit
import AutopodUI
import SwiftUI
import Testing
@testable import AutopodDesktop

@MainActor @Test
func desktopThemeWorkspaceFixturesRenderInEveryPaletteAndAppearance() async throws {
    NSApplication.shared.finishLaunching()
    let oldChoice = DesktopTheme.choice
    let oldStored = UserDefaults.standard.object(forKey: DesktopThemePreferences.storageKey)
    defer {
        DesktopThemePreferences.shared.choice = oldChoice
        if let oldStored { UserDefaults.standard.set(oldStored, forKey: DesktopThemePreferences.storageKey) }
        else { UserDefaults.standard.removeObject(forKey: DesktopThemePreferences.storageKey) }
    }
    let suite = "desktop-theme-layout-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defaults.set(true, forKey: "autopod.desktop.redesign")
    defer { defaults.removePersistentDomain(forName: suite) }
    for dark in [true, false] {
        defaults.set(dark ? "dark" : "light", forKey: "autopod.desktop.appearance")
        let host = NSHostingView(rootView: DesktopDesignPreview().defaultAppStorage(defaults)
            .environment(\.colorScheme, dark ? .dark : .light)
            .frame(width: 1440, height: 960))
        host.sizingOptions = []
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 960),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.orderFront(nil)
        defer { window.contentView = nil; window.close() }
        for choice in DesktopThemeChoice.allCases {
            DesktopThemePreferences.shared.choice = choice
            try await Task.sleep(for: .milliseconds(100))
            window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
            #expect(host.bounds.width == 1440)
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            #expect(bitmap.pixelsWide > 0 && bitmap.pixelsHigh > 0)
            if let output = ProcessInfo.processInfo.environment["AUTOPOD_THEME_SNAPSHOTS"] {
                try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: "\(output)/workspace-\(choice.rawValue)-\(dark ? "dark" : "light").png"))
            }
        }
    }
}
