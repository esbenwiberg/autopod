import AppKit
import Observation

/// Observable image loader that fetches content via an authenticated HTTP request.
/// Shared by ScreenshotThumbnail and ScreenshotLightbox — centralises URLSession,
/// auth-header injection, and error handling so future changes apply in one place.
@Observable final class AuthenticatedImageLoader {
  enum Phase { case idle, loading, loaded(NSImage), failed }

  private(set) var phase: Phase = .idle

  /// Fetches the image at `url`, attaching a Bearer token.
  /// - Parameters:
  ///   - trustedHost: When non-nil, the request is rejected (`.failed`) if the URL's
  ///     host differs from this value. Prevents forwarding the auth token to a
  ///     non-daemon host when the daemon supplies an unexpected absolute URL.
  func load(url: URL, token: String, trustedHost: String? = nil) async {
    // Guard: only forward the auth token to the daemon's own host.
    if let trustedHost, url.host != trustedHost {
      phase = .failed
      return
    }
    phase = .loading
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200,
            let img = NSImage(data: data) else {
        phase = .failed
        return
      }
      phase = .loaded(img)
    } catch {
      phase = .failed
    }
  }

  func reset() {
    phase = .idle
  }
}
