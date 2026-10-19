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

public enum DesktopSettingsRoute: Hashable, CaseIterable {
    case appearance, connections, providerAccounts, podsitter, notifications, logs, about
}

extension EnvironmentValues {
    @Entry public var desktopWorkspaceDirty: ((Bool) -> Void)? = nil
    @Entry public var desktopWorkspaceBusy: ((Bool) -> Void)? = nil
    @Entry var desktopOpenProviderAccounts: (() -> Void)? = nil
    @Entry public var desktopOpenConfiguration: ((ConfigurationKind) -> Void)? = nil
    @Entry var desktopSeriesOpenPod: ((String, DetailTab) -> Void)? = nil
    @Entry public var desktopRedesign = false
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
    @AppStorage("autopod.desktop.appearance") private var appearance = DesktopAppearance.system
    public init() {}
    public var body: some View {
        if redesign {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("THIS MAC").font(.system(size: 9, weight: .medium)).tracking(1.2).foregroundStyle(
                        .secondary)
                    Text("Appearance").font(.title2.weight(.semibold))
                    Text("Choose how Autopod looks.").font(.callout).foregroundStyle(.secondary)
                    DesktopPanel(title: "Color scheme") {
                        Text("Follow the system appearance or choose a fixed theme.").font(.callout)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 14) {
                            ForEach(DesktopAppearance.allCases) { choice in
                                Button {
                                    appearance = choice
                                } label: {
                                    VStack(alignment: .leading, spacing: 10) {
                                        HStack(spacing: 6) {
                                            RoundedRectangle(cornerRadius: 3).fill(DesktopTheme.selection)
                                                .frame(width: 22)
                                            VStack(spacing: 5) {
                                                RoundedRectangle(cornerRadius: 3).fill(DesktopTheme.line)
                                                    .frame(height: 15)
                                                Spacer(minLength: 0)
                                            }
                                        }.padding(8).frame(height: 64)
                                            .background(
                                                choice == .dark
                                                    ? Color(red: 0.10, green: 0.14, blue: 0.11)
                                                    : choice == .light ? .white : DesktopTheme.surface,
                                                in: RoundedRectangle(cornerRadius: 5))
                                        Text(choice.label).font(.caption)
                                    }.padding(12).frame(width: 135)
                                        .background(
                                            appearance == choice
                                                ? DesktopTheme.selection : DesktopTheme.surface,
                                            in: RoundedRectangle(cornerRadius: 7)
                                        )
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 7).stroke(
                                                appearance == choice ? DesktopTheme.accent : DesktopTheme.line
                                            ))
                                }.buttonStyle(.plain).accessibilityLabel(choice.label)
                                    .accessibilityAddTraits(appearance == choice ? .isSelected : [])
                            }
                        }
                    }
                    DesktopPanel(title: "Desktop redesign") {
                        Toggle("New desktop interface", isOn: $redesign)
                        Text("Compare the redesigned workspace with the current interface.").font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: 1000, alignment: .leading).padding(28)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(DesktopTheme.canvas)
        } else {
            Form {
                Section("Appearance") { DesktopAppearancePicker() }
                Section("Desktop redesign") {
                    Toggle("New desktop interface", isOn: $redesign)
                    Text("Compare the redesigned workspace with the current interface.").font(.caption)
                        .foregroundStyle(.secondary)
                }
            }.formStyle(.grouped)
        }
    }
}
