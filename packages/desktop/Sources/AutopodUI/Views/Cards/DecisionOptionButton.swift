import SwiftUI

/// One escalation choice. The label wraps to show the full option text; the
/// native bordered macOS button clips its label to a single line (#649).
struct DecisionOptionButton: View {
  let option: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "circle").font(.system(size: 11))
        Text(option)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .contentShape(RoundedRectangle(cornerRadius: 6))
    }
    .buttonStyle(DecisionOptionButtonStyle())
  }
}

private struct DecisionOptionButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(Color.orange)
      .background(
        RoundedRectangle(cornerRadius: 6)
          .fill(Color.orange.opacity(configuration.isPressed ? 0.24 : 0.12))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 6)
          .stroke(Color.orange.opacity(0.25), lineWidth: 0.5)
      )
      .opacity(isEnabled ? 1 : 0.5)
  }
}
