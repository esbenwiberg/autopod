import AppKit
import AutopodClient
import SwiftUI

public enum DesktopAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    public var id: String { rawValue }
    public var label: String { rawValue.capitalized }
    public var colorScheme: ColorScheme? {
        switch self { case .system: nil; case .light: .light; case .dark: .dark }
    }
}

extension EnvironmentValues {
    @Entry var desktopRedesign = false
    @Entry var desktopRepositories: [String: DesktopRepository] = [:]
    @Entry var desktopPodSelection: ((String) -> Void)? = nil
    @Entry var desktopRepositoryFilter: ((String) -> Void)? = nil
}

@MainActor
public enum DesktopTheme {
    public static var canvas: Color { adaptive(0xF3F5F2, 0x181E1B) }
    public static var surface: Color { adaptive(0xFFFFFF, 0x202722) }
    public static var sidebar: Color { adaptive(0xEAF0E9, 0x1C241F) }
    public static var line: Color { adaptive(0xDDE5DD, 0x354138) }
    public static var accent: Color { adaptive(0x277D68, 0x83C9AE) }
    public static var selection: Color { adaptive(0xDFEDE5, 0x2B4034) }
    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: Double((hex >> 16) & 255) / 255,
                           green: Double((hex >> 8) & 255) / 255,
                           blue: Double(hex & 255) / 255, alpha: 1)
        })
    }
}

public struct DesktopAppearancePicker: View {
    @AppStorage("autopod.desktop.appearance") private var appearance = DesktopAppearance.system
    public init() {}
    public var body: some View {
        Picker("Appearance", selection: $appearance) {
            ForEach(DesktopAppearance.allCases) { Text($0.label).tag($0) }
        }
        .font(.caption).controlSize(.small)
        .accessibilityIdentifier("desktop-appearance")
    }
}

public struct DesktopAppearanceModifier: ViewModifier {
    @AppStorage("autopod.desktop.appearance") private var appearance = DesktopAppearance.system
    public init() {}
    public func body(content: Content) -> some View {
        content.preferredColorScheme(appearance.colorScheme)
    }
}

public struct DesktopAppearanceSettings: View {
    @AppStorage("autopod.desktop.redesign") private var redesign = DesktopIdentity.isPreview
    public init() {}
    public var body: some View {
        Form {
            Section("Appearance") { DesktopAppearancePicker() }
            Section("Desktop redesign") {
                Toggle("New desktop interface", isOn: $redesign)
                Text("Compare the new shell, fleet, and overview with the current interface.").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }
}
