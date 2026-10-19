import SwiftUI

/// Shared presentation for secondary workflows. The enclosing sheet owns dismissal
/// and its existing actions; this style only supplies the desktop visual language.
public struct DesktopDialogStyle: ViewModifier {
    @Environment(\.desktopRedesign) private var redesign
    let eyebrow: String
    let title: String
    let subtitle: String?
    let width: CGFloat
    let height: CGFloat?
    let legacyWidth: CGFloat
    let legacyHeight: CGFloat?
    let legacyPadding: CGFloat

    public func body(content: Content) -> some View {
        if redesign {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(eyebrow.uppercased())
                        .font(.system(size: 9, weight: .semibold)).tracking(1.3)
                        .foregroundStyle(.secondary)
                    Text(title).font(.title2.weight(.semibold))
                    if let subtitle {
                        Text(subtitle).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(24).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesktopTheme.surface)
                DesktopTheme.line.frame(height: 1)
                content.padding(24)
                    .frame(maxWidth: .infinity, maxHeight: height == nil ? nil : .infinity,
                           alignment: .topLeading)
            }
            .frame(width: width, height: height)
            .background(DesktopTheme.canvas).tint(DesktopTheme.accent)
            .accessibilityIdentifier("desktop-secondary-dialog")
        } else {
            content.padding(legacyPadding).frame(width: legacyWidth, height: legacyHeight)
        }
    }
}

public extension View {
    func desktopDialog(
        _ title: String, eyebrow: String, subtitle: String? = nil,
        width: CGFloat = 680, height: CGFloat? = nil,
        legacyWidth: CGFloat, legacyHeight: CGFloat? = nil, legacyPadding: CGFloat = 20
    ) -> some View {
        modifier(DesktopDialogStyle(eyebrow: eyebrow, title: title, subtitle: subtitle,
            width: width, height: height, legacyWidth: legacyWidth,
            legacyHeight: legacyHeight, legacyPadding: legacyPadding))
    }

    func desktopFormSection() -> some View { modifier(DesktopFormSectionStyle()) }
    func desktopDialogActions() -> some View { modifier(DesktopDialogActionsStyle()) }
}

private struct DesktopFormSectionStyle: ViewModifier {
    @Environment(\.desktopRedesign) private var redesign
    func body(content: Content) -> some View {
        if redesign {
            content.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(DesktopTheme.line))
        } else { content }
    }
}

private struct DesktopDialogActionsStyle: ViewModifier {
    @Environment(\.desktopRedesign) private var redesign
    func body(content: Content) -> some View {
        if redesign {
            content.padding(.top, 18)
                .overlay(alignment: .top) { DesktopTheme.line.frame(height: 1) }
        } else { content }
    }
}

public struct DesktopGroupBoxStyle: GroupBoxStyle {
    @Environment(\.desktopRedesign) private var redesign
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        if redesign {
            VStack(alignment: .leading, spacing: 14) {
                configuration.label.font(.callout.weight(.semibold))
                configuration.content.frame(maxWidth: .infinity, alignment: .leading)
            }.desktopFormSection()
        } else {
            GroupBox { configuration.content } label: { configuration.label }
                .groupBoxStyle(.automatic)
        }
    }
}
