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
    public static var choice: DesktopThemeChoice { DesktopThemePreferences.shared.choice }
    public static var canvas: Color { choice.adaptive(\.canvas) }
    public static var surface: Color { choice.adaptive(\.surface) }
    public static var sidebar: Color { choice.adaptive(\.sidebar) }
    public static var line: Color { choice.adaptive(\.line) }
    public static var accent: Color { choice.adaptive(\.accent) }
    public static var selection: Color { choice.adaptive(\.selection) }
    public static var success: Color { choice.adaptive(\.success) }

    /// Semantic colors remain recognizable regardless of the decorative accent.
    public static func statusColor(_ status: PodStatus) -> Color {
        switch status {
        case .provisioning, .running, .validating, .merging, .handoff:
            choice.adaptive(\.info)
        case .awaitingInput, .reviewRequired, .researchReady, .validated, .mergePending:
            choice.adaptive(\.warning)
        case .complete, .approved:
            success
        case .failed, .killing:
            choice.adaptive(\.danger)
        case .queued, .paused, .killed:
            choice.adaptive(\.muted)
        }
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
    @Environment(\.colorScheme) private var colorScheme
    @Bindable private var preferences = DesktopThemePreferences.shared
    public init() {}
    public var body: some View {
        if redesign {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("THIS MAC").font(.system(size: 9, weight: .medium)).tracking(1.2).foregroundStyle(
                        .secondary)
                    Text("Appearance").font(.title2.weight(.semibold))
                    ConfigurationContextHelp(topicID: "app.sections.appearance")
                    DesktopPanel(title: "Theme") {
                        Text("A palette for your workspace. Saved on this Mac and applied immediately.")
                            .font(.callout).foregroundStyle(.secondary)
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .top, spacing: 12) {
                                ForEach(DesktopThemeChoice.allCases) { choice in
                                    themeCard(choice).frame(minWidth: 170)
                                }
                            }
                            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                                ForEach(DesktopThemeChoice.allCases) { themeCard($0) }
                            }
                        }
                    }
                    DesktopPanel(title: "Color scheme") {
                        Text("Each theme supports light and dark. Follow macOS or choose a fixed appearance.")
                            .font(.callout).foregroundStyle(.secondary)
                        DesktopAppearancePicker().frame(maxWidth: 360, alignment: .leading)
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
                Section("Appearance") {
                    ConfigurationContextHelp(topicID: "app.sections.appearance")
                    DesktopAppearancePicker()
                    Text("Enable the new desktop interface below to choose a workspace theme.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Desktop redesign") {
                    Toggle("New desktop interface", isOn: $redesign)
                    Text("Compare the redesigned workspace with the current interface.").font(.caption)
                        .foregroundStyle(.secondary)
                }
            }.formStyle(.grouped)
        }
    }

    private func themeCard(_ choice: DesktopThemeChoice) -> some View {
        DesktopThemePreviewCard(choice: choice, dark: colorScheme == .dark,
            isSelected: preferences.choice == choice) {
                preferences.choice = choice
            }
    }
}
