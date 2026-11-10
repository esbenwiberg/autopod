import SwiftUI

/// Presentation only. Recovery controllers continue to own all observation and permission.
@MainActor enum RecoveryPalette {
  static var secondary: Color { DesktopTheme.choice.adaptive(\.secondary) }
}

enum RecoveryTone {
  case standard, attention, destructive

  @MainActor var color: Color {
    switch self {
    case .standard: DesktopTheme.accent
    case .attention: DesktopTheme.statusColor(.reviewRequired)
    case .destructive: DesktopTheme.statusColor(.failed)
    }
  }
}

struct RecoveryIcon: View {
  let symbol: String
  var tone = RecoveryTone.standard

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: 16, weight: .medium))
      .foregroundStyle(tone.color)
      .frame(width: 36, height: 36)
      .background(tone.color.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
      .accessibilityHidden(true)
  }
}

struct RecoveryBadge: View {
  let title: String
  var tone = RecoveryTone.attention

  var body: some View {
    Text(title).font(.caption.weight(.medium))
      .foregroundStyle(tone.color)
      .padding(.horizontal, 9).padding(.vertical, 4)
      .background(tone.color.opacity(0.09), in: Capsule())
      .fixedSize(horizontal: true, vertical: false)
  }
}

struct RecoverySectionTitle: View {
  let title: String
  var subtitle: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.headline)
      if let subtitle { Text(subtitle).font(.callout).foregroundStyle(RecoveryPalette.secondary) }
    }
  }
}

struct RecoveryNotice: View {
  let title: String
  let message: String
  var tone = RecoveryTone.attention
  var symbol = "exclamationmark.circle"

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol).foregroundStyle(tone.color).padding(.top, 2).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.callout.weight(.semibold))
        Text(message).font(.callout).foregroundStyle(RecoveryPalette.secondary)
          .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .padding(14)
      .background(tone.color.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(tone.color.opacity(0.23)))
      .accessibilityElement(children: .contain)
  }
}

struct RecoveryStatusCard: View {
  let title: String
  let symbol: String
  let detail: String

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(title, systemImage: symbol).font(.callout.weight(.semibold))
      Text(detail).font(.callout).foregroundStyle(RecoveryPalette.secondary)
        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .recoverySurface(inset: 16)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(title). \(detail)")
  }
}

extension View {
  @MainActor func recoverySurface(inset: CGFloat = 18) -> some View {
    padding(inset).background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).stroke(DesktopTheme.line, lineWidth: 1))
  }
}

/// Native Button semantics are retained. Hover/press feedback changes only the
/// surface; it never changes layout, reveals essential copy, or runs an action.
struct RecoveryNavigationStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View { HoverBody(configuration: configuration) }

  private struct HoverBody: View {
    let configuration: ButtonStyleConfiguration
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var hovered = false

    var body: some View {
      configuration.label
        .background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
          .stroke(enabled && (hovered || configuration.isPressed) ? DesktopTheme.accent : DesktopTheme.line,
            lineWidth: contrast == .increased ? 2 : 1))
        .overlay(RoundedRectangle(cornerRadius: 12)
          .fill(DesktopTheme.accent.opacity(enabled && (hovered || configuration.isPressed) ? 0.055 : 0))
          .allowsHitTesting(false))
        .opacity(enabled ? (configuration.isPressed ? 0.88 : 1) : 0.65)
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onHover { hovered = $0 }
    }
  }
}
