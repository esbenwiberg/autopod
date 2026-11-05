import SwiftUI

/// Always renders the candidate's own colors, not the currently selected palette.
struct DesktopThemePreviewCard: View {
    let choice: DesktopThemeChoice
    let dark: Bool
    let isSelected: Bool
    let onSelect: () -> Void

    private var palette: DesktopPaletteColors { choice.colors(dark: dark) }

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 7) {
                        Circle().fill(palette.color(\.accent)).frame(width: 6, height: 6)
                        miniatureLine(width: 24, color: palette.color(\.secondary))
                        RoundedRectangle(cornerRadius: 3).fill(palette.color(\.selection))
                            .frame(height: 13)
                        miniatureLine(width: 20, color: palette.color(\.secondary))
                        Spacer(minLength: 0)
                    }.padding(8).frame(width: 48).background(palette.color(\.sidebar))
                    VStack(alignment: .leading, spacing: 8) {
                        miniatureLine(width: 52, color: palette.color(\.text))
                        VStack(alignment: .leading, spacing: 6) {
                            miniatureLine(width: 35, color: palette.color(\.accent))
                            miniatureLine(width: 58, color: palette.color(\.secondary))
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(palette.color(\.surface), in: RoundedRectangle(cornerRadius: 4))
                        Spacer(minLength: 0)
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(height: 96).background(palette.color(\.canvas))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(palette.color(\.line)))
                HStack {
                    Text(choice.label).font(.callout.weight(.semibold))
                    Spacer()
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isSelected ? DesktopTheme.accent : DesktopTheme.line)
                }
                Text(choice.subtitle).font(.caption).foregroundStyle(.secondary)
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? DesktopTheme.accent : DesktopTheme.line,
                            lineWidth: isSelected ? 2 : 1))
                .contentShape(RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain)
            .accessibilityLabel("\(choice.label), \(choice.subtitle)")
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("desktop-theme-\(choice.rawValue)")
    }

    private func miniatureLine(width: CGFloat, color: Color) -> some View {
        RoundedRectangle(cornerRadius: 2).fill(color.opacity(0.65)).frame(width: width, height: 4)
    }
}
