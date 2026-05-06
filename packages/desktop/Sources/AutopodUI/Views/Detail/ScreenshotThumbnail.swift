import AppKit
import SwiftUI

/// Renders a proof-of-work screenshot as a capped-height thumbnail.
/// Fetches the image via an authenticated HTTP request (Bearer token from the
/// `daemonAuthToken` environment). Shared between ValidationTab and SummaryTab.
///
/// - Parameters:
///   - ref: The screenshot reference. When nil, the view renders nothing.
///   - allRefs: The full ordered set for this validation attempt (smoke → ac → review).
///              Passed into the lightbox for arrow-key navigation.
///   - onOpen: Called with the index of this ref within `allRefs` when the thumbnail is clicked.
///   - maxHeight: Maximum rendered height in points (default 300).
public struct ScreenshotThumbnail: View {
  public let ref: ScreenshotRef?
  public let allRefs: [ScreenshotRef]
  public let onOpen: (Int) -> Void
  public var maxHeight: CGFloat = 300
  /// Whether the image fills its bounds (grid cards) or fits within maxHeight (inline rows).
  public var fillMode: Bool = false

  @Environment(\.daemonAuthToken) private var token
  @State private var loadedImage: NSImage?
  @State private var phase: LoadPhase = .idle
  @State private var retryToken = UUID()

  private enum LoadPhase { case idle, loading, loaded, failed }

  public init(
    ref: ScreenshotRef?,
    allRefs: [ScreenshotRef] = [],
    onOpen: @escaping (Int) -> Void = { _ in },
    maxHeight: CGFloat = 300,
    fillMode: Bool = false
  ) {
    self.ref = ref
    self.allRefs = allRefs
    self.onOpen = onOpen
    self.maxHeight = maxHeight
    self.fillMode = fillMode
  }

  public var body: some View {
    if let ref {
      thumbnailContent(ref)
    }
  }

  @ViewBuilder
  private func thumbnailContent(_ ref: ScreenshotRef) -> some View {
    let frameShape = RoundedRectangle(cornerRadius: 6)
    Group {
      switch phase {
      case .idle, .loading:
        ProgressView()
          .frame(height: min(maxHeight, 60))
          .frame(maxWidth: .infinity)
          .background(Color.secondary.opacity(0.06))
          .clipShape(frameShape)

      case .loaded:
        if let img = loadedImage {
          Image(nsImage: img)
            .resizable()
            .aspectRatio(contentMode: fillMode ? .fill : .fit)
            .frame(maxHeight: maxHeight)
            .clipShape(frameShape)
            .overlay(frameShape.stroke(Color.secondary.opacity(0.3), lineWidth: 1))
            .contentShape(frameShape)
            .onTapGesture {
              let idx = allRefs.firstIndex(where: { $0.id == ref.id }) ?? 0
              onOpen(idx)
            }
            .cursor(.pointingHand)
        }

      case .failed:
        VStack(spacing: 4) {
          Image(systemName: "photo.badge.exclamationmark")
            .font(.system(size: 22))
            .foregroundStyle(.secondary)
          Text("Tap to retry")
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .frame(height: min(maxHeight, 60))
        .frame(maxWidth: .infinity)
        .background(Color.secondary.opacity(0.06))
        .clipShape(frameShape)
        .onTapGesture { retryToken = UUID() }
      }
    }
    .task(id: "\(ref.url.absoluteString)-\(retryToken)") {
      await loadImage(url: ref.url)
    }
  }

  private func loadImage(url: URL) async {
    phase = .loading
    loadedImage = nil
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        phase = .failed
        return
      }
      guard let img = NSImage(data: data) else {
        phase = .failed
        return
      }
      loadedImage = img
      phase = .loaded
    } catch {
      phase = .failed
    }
  }
}

// MARK: - Cursor helper

private extension View {
  /// Adds a pointing-hand cursor on hover (macOS only).
  @ViewBuilder
  func cursor(_ cursor: NSCursor) -> some View {
    self.onHover { inside in
      if inside { cursor.push() } else { NSCursor.pop() }
    }
  }
}
