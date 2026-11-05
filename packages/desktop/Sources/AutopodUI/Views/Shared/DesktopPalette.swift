import AppKit
import Observation
import SwiftUI

/// A palette is independent of the user's System / Light / Dark preference.
public enum DesktopThemeChoice: String, CaseIterable, Identifiable, Sendable {
    case rex, slate, ember, paper

    public var id: String { rawValue }
    public var label: String { rawValue.capitalized }
    public var subtitle: String {
        switch self {
        case .rex: "Charcoal · lavender"
        case .slate: "Graphite · blue"
        case .ember: "Warm charcoal · copper"
        case .paper: "Ivory · ink"
        }
    }

    public func colors(dark: Bool) -> DesktopPaletteColors {
        switch (self, dark) {
        case (.rex, false):
            DesktopPaletteColors(canvas: 0xF3F3F6, surface: 0xFFFFFF, sidebar: 0xEAEAF0,
                line: 0xD9D9E3, accent: 0x6552A0, selection: 0xE7E2F2)
        case (.rex, true):
            DesktopPaletteColors(canvas: 0x0D1117, surface: 0x161B22, sidebar: 0x090D12,
                line: 0x30363F, accent: 0xB6A4E3, selection: 0x273B4B, dark: true)
        case (.slate, false):
            DesktopPaletteColors(canvas: 0xF0F3F7, surface: 0xFFFFFF, sidebar: 0xE7EDF4,
                line: 0xD4DDE8, accent: 0x315E91, selection: 0xDCE8F6)
        case (.slate, true):
            DesktopPaletteColors(canvas: 0x151B25, surface: 0x1D2633, sidebar: 0x111720,
                line: 0x364459, accent: 0x94BAE6, selection: 0x2B405C, dark: true)
        case (.ember, false):
            DesktopPaletteColors(canvas: 0xF6F1ED, surface: 0xFFFCF9, sidebar: 0xEEE5DE,
                line: 0xDFD2C8, accent: 0x914B2B, selection: 0xF0DFD2)
        case (.ember, true):
            DesktopPaletteColors(canvas: 0x201916, surface: 0x2A211C, sidebar: 0x191411,
                line: 0x4B3B31, accent: 0xE5AD86, selection: 0x493225, dark: true)
        case (.paper, false):
            DesktopPaletteColors(canvas: 0xF6F3EB, surface: 0xFFFEF9, sidebar: 0xECE8DC,
                line: 0xDAD5C8, accent: 0x3D5D7A, selection: 0xE0E7E9)
        case (.paper, true):
            DesktopPaletteColors(canvas: 0x242320, surface: 0x2D2C28, sidebar: 0x1C1C19,
                line: 0x4B4941, accent: 0xAAC2D3, selection: 0x3A464A, dark: true)
        }
    }

    @MainActor func adaptive(_ token: KeyPath<DesktopPaletteColors, UInt32>) -> Color {
        let light = colors(dark: false)[keyPath: token]
        let dark = colors(dark: true)[keyPath: token]
        return Color(nsColor: NSColor(name: nil) { appearance in
            DesktopPaletteColors.native(
                appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light)
        })
    }
}

/// Immutable, explicitly resolved values used by previews, AppKit and contrast tests.
public struct DesktopPaletteColors: Equatable, Sendable {
    public let canvas, surface, sidebar, line, accent, selection: UInt32
    public let text, secondary, success, info, warning, danger, muted, cyan: UInt32

    init(canvas: UInt32, surface: UInt32, sidebar: UInt32, line: UInt32,
         accent: UInt32, selection: UInt32, dark: Bool = false) {
        self.canvas = canvas; self.surface = surface; self.sidebar = sidebar
        self.line = line; self.accent = accent; self.selection = selection
        text = dark ? 0xE6E8ED : 0x242830
        secondary = dark ? 0xB0B4BE : 0x5C606A
        // Status never inherits the decorative accent (e.g. amber must not mean success).
        success = dark ? 0x9BC9AA : 0x326B47
        info = dark ? 0x9BBFE5 : 0x315F86
        warning = dark ? 0xE0BF85 : 0x80591C
        danger = dark ? 0xEBA8A2 : 0xA13D39
        muted = dark ? 0xB2B7BE : 0x5C636B
        cyan = dark ? 0x94CBCB : 0x276B70
    }

    public static func native(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: Double((hex >> 16) & 255) / 255,
                green: Double((hex >> 8) & 255) / 255,
                blue: Double(hex & 255) / 255, alpha: 1)
    }

    public func color(_ token: KeyPath<DesktopPaletteColors, UInt32>) -> Color {
        Color(nsColor: Self.native(self[keyPath: token]))
    }

    /// ANSI meanings stay stable across themes; explicit 24-bit application colors are untouched.
    public var ansi: [UInt32] {
        [muted, danger, success, warning, info, accent, cyan, text,
         secondary, danger, success, warning, info, accent, cyan, text]
    }
}

/// One app-wide preference, observed wherever the existing DesktopTheme tokens are read.
/// Changing it invalidates colors, not view identity, drafts, or live connections.
@MainActor @Observable
public final class DesktopThemePreferences {
    public static let shared = DesktopThemePreferences()
    public static let storageKey = "autopod.desktop.theme"
    @ObservationIgnored private let defaults: UserDefaults

    public var choice: DesktopThemeChoice {
        didSet { defaults.set(choice.rawValue, forKey: Self.storageKey) }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        choice = defaults.string(forKey: Self.storageKey).flatMap(DesktopThemeChoice.init(rawValue:)) ?? .rex
    }
}
