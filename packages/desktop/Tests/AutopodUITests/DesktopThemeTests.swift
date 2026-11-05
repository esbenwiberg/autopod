import AppKit
import AutopodClient
import Observation
import SwiftTerm
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor
struct DesktopThemeTests {
    @Test func persistenceFallbackAndAppearanceIndependence() throws {
        let suite = "desktop-theme-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("dark", forKey: "autopod.desktop.appearance")
        #expect(DesktopThemePreferences(defaults: defaults).choice == .rex)
        defaults.set("removed-theme", forKey: DesktopThemePreferences.storageKey)
        #expect(DesktopThemePreferences(defaults: defaults).choice == .rex)
        let preferences = DesktopThemePreferences(defaults: defaults)
        for choice in DesktopThemeChoice.allCases {
            preferences.choice = choice
            #expect(DesktopThemePreferences(defaults: defaults).choice == choice)
            #expect(defaults.string(forKey: DesktopThemePreferences.storageKey) == choice.rawValue)
            #expect(defaults.string(forKey: "autopod.desktop.appearance") == "dark")
        }
    }

    @Test func allPalettesHaveReadableTextStatusAndTerminalColors() {
        for choice in DesktopThemeChoice.allCases {
            for dark in [false, true] {
                let p = choice.colors(dark: dark)
                #expect(p.accent != p.success)
                #expect(p.ansi.count == 16)
                for background in [p.canvas, p.surface, p.sidebar, p.selection] {
                    for foreground in [p.text, p.secondary, p.accent, p.success, p.info, p.warning, p.danger, p.muted] {
                        #expect(contrast(foreground, background) >= 4.5,
                            "\(choice) dark=\(dark): \(String(foreground, radix: 16)) on \(String(background, radix: 16))")
                    }
                }
                for foreground in p.ansi {
                    #expect(contrast(foreground, p.canvas) >= 4.5)
                }
            }
        }
    }

    @Test func pickerSwitchesLiveAndRendersAllThemesInBothAppearances() async throws {
        let restore = saveSharedTheme()
        defer { restore() }
        let suite = "desktop-theme-picker-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set(true, forKey: "autopod.desktop.redesign")
        defaults.set("system", forKey: "autopod.desktop.appearance")
        defer { defaults.removePersistentDomain(forName: suite) }
        for light in [false, true] {
            for width in [760.0, 1040.0] {
                let host = LaunchComposerHost(DesktopAppearanceSettings().defaultAppStorage(defaults),
                    width: width, light: light)
                defer { host.close() }
                for choice in DesktopThemeChoice.allCases {
                    try await host.wait { host.has("desktop-theme-\(choice.rawValue)") }
                    try host.press("desktop-theme-\(choice.rawValue)")
                    try await host.wait { DesktopTheme.choice == choice }
                    #expect(defaults.string(forKey: "autopod.desktop.appearance") == "system")
                    #expect(DesktopThemePreferences().choice == choice)
                    // Static-token access must be tracked by SwiftUI's Observation machinery.
                    let expected = choice.colors(dark: !light).canvas
                    try await host.wait {
                        guard let bitmap = host.hosting.bitmapImageRepForCachingDisplay(in: host.hosting.bounds) else { return false }
                        host.hosting.cacheDisplay(in: host.hosting.bounds, to: bitmap)
                        // Cached AppKit bitmaps use calibrated RGB with small rounding differences.
                        guard let sampled = bitmap.colorAt(x: 3, y: 3) else { return false }
                        let expectedColor = DesktopPaletteColors.native(expected)
                        return abs(sampled.redComponent - expectedColor.redComponent) < 0.006
                            && abs(sampled.greenComponent - expectedColor.greenComponent) < 0.006
                            && abs(sampled.blueComponent - expectedColor.blueComponent) < 0.006
                    }
                    if let output = ProcessInfo.processInfo.environment["AUTOPOD_THEME_SNAPSHOTS"] {
                        try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
                        let bitmap = try #require(host.hosting.bitmapImageRepForCachingDisplay(in: host.hosting.bounds))
                        host.hosting.cacheDisplay(in: host.hosting.bounds, to: bitmap)
                        let png = try #require(bitmap.representation(using: .png, properties: [:]))
                        try png.write(to: URL(fileURLWithPath: "\(output)/\(choice.rawValue)-\(light ? "light" : "dark")-\(Int(width)).png"))
                    }
                }
            }
        }
    }

    @Test func terminalUpdatesInPlaceWithoutLosingScrollbackOrCallbacks() async throws {
        let restore = saveSharedTheme()
        defer { restore() }
        DesktopThemePreferences.shared.choice = .rex
        let inputs = ThemeTerminalInputs()
        let host = LaunchComposerHost(ThemeTerminalFixture(inputs: inputs), width: 760)
        defer { host.close() }
        try await host.wait { terminalViews(host.hosting).count == 1 }
        let terminal = try #require(terminalViews(host.hosting).first)
        inputs.pipe.feed(Data((0..<100).map { "saved-line-\($0)\r\n" }.joined().utf8))
        let engine = terminal.getTerminal()
        let firstLine = try #require(engine.getScrollInvariantLine(row: 0)?.translateToString(trimRight: true))
        #expect(firstLine == "saved-line-0")
        #expect(engine.buffer.yDisp > 0)
        let scrollPosition = engine.buffer.yDisp
        let originalDelegate = terminal.terminalDelegate
        for dark in [true, false] {
            inputs.dark = dark
            for choice in DesktopThemeChoice.allCases {
                DesktopThemePreferences.shared.choice = choice
                let palette = choice.colors(dark: dark)
                try await host.wait {
                    matches(terminal.nativeBackgroundColor, palette.canvas)
                        && matches(terminal.caretColor, palette.accent)
                        && matches(terminal.selectedTextBackgroundColor, palette.selection)
                }
                #expect(terminalViews(host.hosting).first === terminal)
                #expect(terminal.getTerminal() === engine)
                #expect(terminal.terminalDelegate === originalDelegate)
                #expect(engine.getScrollInvariantLine(row: 0)?.translateToString(trimRight: true) == firstLine)
                #expect(engine.buffer.yDisp == scrollPosition)
                #expect(matches(terminal.nativeForegroundColor, palette.text))
                #expect(matches(terminal.caretColor, palette.accent))
                #expect(matches(terminal.selectedTextBackgroundColor, palette.selection))
            }
        }
        // The pipe still targets the same view; the coordinator still forwards user input.
        inputs.pipe.feed(Data("after-theme-switch".utf8))
        #expect(engine.getLine(row: engine.rows - 1)?.translateToString(trimRight: true) == "after-theme-switch")
        terminal.terminalDelegate?.send(source: terminal, data: ArraySlice("typed".utf8))
        #expect(inputs.sent == Array("typed".utf8))
        #expect(inputs.connects == 0)
        #expect(inputs.mounts == 1)
    }
}

@MainActor @Observable private final class ThemeTerminalInputs {
    let pipe = TerminalDataPipe()
    var dark = true
    var sent: [UInt8] = []
    var connects = 0
    var mounts = 0
}

@MainActor private struct ThemeTerminalFixture: View {
    let inputs: ThemeTerminalInputs
    var body: some View {
        TerminalTab(pod: Pod(id: "theme-terminal", status: .running, branch: "fixture",
            profileName: "fixture", task: "Theme test", model: "fixture", startedAt: .now),
            terminalState: "connected", dataPipe: inputs.pipe,
            onSendData: { inputs.sent += $0 }, onResize: { _, _ in },
            onConnect: { inputs.connects += 1 }, isSelected: true)
            .environment(\.colorScheme, inputs.dark ? .dark : .light)
            .onAppear { inputs.mounts += 1 }
    }
}

@MainActor private func saveSharedTheme() -> () -> Void {
    let choice = DesktopTheme.choice
    let stored = UserDefaults.standard.object(forKey: DesktopThemePreferences.storageKey)
    return {
        DesktopThemePreferences.shared.choice = choice
        if let stored { UserDefaults.standard.set(stored, forKey: DesktopThemePreferences.storageKey) }
        else { UserDefaults.standard.removeObject(forKey: DesktopThemePreferences.storageKey) }
    }
}

@MainActor private func terminalViews(_ view: NSView) -> [TerminalView] {
    (view as? TerminalView).map { [$0] } ?? view.subviews.flatMap(terminalViews)
}

@MainActor private func matches(_ color: NSColor?, _ hex: UInt32) -> Bool {
    guard let color = color?.usingColorSpace(.sRGB) else { return false }
    let expected = DesktopPaletteColors.native(hex)
    return abs(color.redComponent - expected.redComponent) < 0.002
        && abs(color.greenComponent - expected.greenComponent) < 0.002
        && abs(color.blueComponent - expected.blueComponent) < 0.002
}

private func contrast(_ foreground: UInt32, _ background: UInt32) -> Double {
    func luminance(_ hex: UInt32) -> Double {
        func linear(_ value: UInt32) -> Double {
            let v = Double(value) / 255
            return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear((hex >> 16) & 255) + 0.7152 * linear((hex >> 8) & 255) + 0.0722 * linear(hex & 255)
    }
    let a = luminance(foreground), b = luminance(background)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
}
