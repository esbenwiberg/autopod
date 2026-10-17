import SwiftUI

/// Compact section navigation shared by the redesigned detail panes.
struct DesktopSectionPicker<Item: Hashable>: View {
    let title: String
    let items: [Item]
    @Binding var selection: Item
    let label: (Item) -> String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                Text(title).font(.title3.weight(.semibold))
                Spacer(minLength: 8)
                buttons
            }
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.title3.weight(.semibold))
                ScrollView(.horizontal, showsIndicators: false) { buttons }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .background(DesktopTheme.surface)
    }

    private var buttons: some View {
        HStack(spacing: 4) {
            ForEach(items, id: \.self) { item in
                Button { selection = item } label: {
                    Text(label(item)).font(.caption.weight(selection == item ? .semibold : .regular))
                        .fixedSize().padding(.horizontal, 10).padding(.vertical, 7)
                        .foregroundStyle(selection == item ? DesktopTheme.accent : .secondary)
                        .background(selection == item ? DesktopTheme.selection : .clear, in: RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == item ? .isSelected : [])
            }
        }
    }
}

struct DesktopPanel<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.subheadline.weight(.semibold))
            content()
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(DesktopTheme.line, lineWidth: 1))
    }
}
