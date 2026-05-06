import AppKit
import SwiftUI

/// Full-resolution screenshot viewer with arrow-key navigation across a validation
/// attempt's screenshot set (smoke → ac → review, filename-sorted within bucket).
///
/// Presented as a full-frame overlay with a translucent dark backdrop:
/// ```swift
/// .overlay {
///   if isPresented {
///     ScreenshotLightbox(refs: set, currentIndex: $idx, isPresented: $isPresented)
///   }
/// }
/// ```
public struct ScreenshotLightbox: View {
  public let refs: [ScreenshotRef]
  @Binding public var currentIndex: Int
  @Binding public var isPresented: Bool

  @Environment(\.daemonAuthToken) private var token
  @State private var loadedImage: NSImage?
  @State private var phase: LoadPhase = .idle
  @State private var retryToken = UUID()

  private enum LoadPhase { case idle, loading, loaded, failed }

  public init(refs: [ScreenshotRef], currentIndex: Binding<Int>, isPresented: Binding<Bool>) {
    self.refs = refs
    self._currentIndex = currentIndex
    self._isPresented = isPresented
  }

  private var currentRef: ScreenshotRef? {
    guard refs.indices.contains(currentIndex) else { return nil }
    return refs[currentIndex]
  }

  public var body: some View {
    ZStack {
      // Translucent backdrop — click to dismiss
      Color.black.opacity(0.78)
        .ignoresSafeArea()
        .onTapGesture { isPresented = false }

      VStack(spacing: 0) {
        // Top bar: caption + close button
        HStack(spacing: 8) {
          Text(currentRef.map { pathCaption($0) } ?? "")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.white.opacity(0.65))
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: .infinity, alignment: .leading)

          Button {
            isPresented = false
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.title3)
              .foregroundStyle(.white.opacity(0.7))
              .symbolRenderingMode(.hierarchical)
          }
          .buttonStyle(.plain)
          .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)

        // Image area
        ZStack {
          switch phase {
          case .idle, .loading:
            ProgressView()
              .tint(.white)
              .scaleEffect(1.4)

          case .loaded:
            if let img = loadedImage {
              Image(nsImage: img)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

          case .failed:
            VStack(spacing: 10) {
              Image(systemName: "photo.badge.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(.white.opacity(0.5))
              Text("Couldn't load screenshot")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.6))
              Text("Tap to retry")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.35))
            }
            .onTapGesture { retryToken = UUID() }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)

        // Bottom nav bar
        HStack(spacing: 24) {
          Button {
            guard currentIndex > 0 else { return }
            currentIndex -= 1
          } label: {
            Image(systemName: "chevron.left")
              .font(.title3.weight(.semibold))
              .foregroundStyle(currentIndex > 0 ? .white : .white.opacity(0.25))
          }
          .buttonStyle(.plain)
          .disabled(currentIndex == 0)

          Text("\(currentIndex + 1) / \(refs.count)")
            .font(.caption)
            .foregroundStyle(.white.opacity(0.55))
            .monospacedDigit()

          Button {
            guard currentIndex < refs.count - 1 else { return }
            currentIndex += 1
          } label: {
            Image(systemName: "chevron.right")
              .font(.title3.weight(.semibold))
              .foregroundStyle(currentIndex < refs.count - 1 ? .white : .white.opacity(0.25))
          }
          .buttonStyle(.plain)
          .disabled(currentIndex == refs.count - 1)
        }
        .padding(.vertical, 12)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .focusable()
    .onKeyPress(.leftArrow) {
      if currentIndex > 0 { currentIndex -= 1 }
      return .handled
    }
    .onKeyPress(.rightArrow) {
      if currentIndex < refs.count - 1 { currentIndex += 1 }
      return .handled
    }
    .task(id: "\(currentIndex)-\(retryToken)") {
      if let ref = currentRef { await loadImage(url: ref.url) }
    }
    .onChange(of: currentIndex) { _, _ in
      loadedImage = nil
      phase = .idle
    }
  }

  // MARK: - Helpers

  private func pathCaption(_ ref: ScreenshotRef) -> String {
    ref.url.path
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
