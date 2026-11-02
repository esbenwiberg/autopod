import AppKit
import SwiftUI

/// Shared native hover affordance for card navigation, filtering and external links.
/// Keeps native button/link keyboard behavior and does not resize the card on hover.
struct DesktopCardLinkStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverBody(configuration: configuration)
    }

    private struct HoverBody: View {
        let configuration: Configuration
        @State private var hovered = false

        var body: some View {
            configuration.label
                .symbolVariant(hovered ? .fill : .none)
                .opacity(configuration.isPressed ? 0.65 : 1)
                .background(DesktopTheme.accent.opacity(hovered ? 0.10 : 0),
                            in: RoundedRectangle(cornerRadius: 3))
                .contentShape(Rectangle())
                .onHover { inside in
                    hovered = inside
                    if inside { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
                }
                .onDisappear {
                    if hovered { NSCursor.arrow.set() }
                }
        }
    }
}
