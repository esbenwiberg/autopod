import SwiftUI

/// Renders a base64-encoded PNG as a capped-height thumbnail with a subtle border.
/// Shared between ValidationTab (failure screenshots) and SummaryTab (proof-of-work).
@ViewBuilder
func screenshotThumbnail(_ base64: String?, maxHeight: CGFloat = 300) -> some View {
  if let base64, let data = Data(base64Encoded: base64), let nsImage = NSImage(data: data) {
    Image(nsImage: nsImage)
      .resizable()
      .aspectRatio(contentMode: .fit)
      .frame(maxHeight: maxHeight)
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
  }
}
