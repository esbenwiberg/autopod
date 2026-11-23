import Foundation

/// Preview builds never register production deep links or use production Keychain items.
public enum DesktopIdentity {
  public static var isPreview: Bool {
    Bundle.main.object(forInfoDictionaryKey: "AutopodPreview") as? Bool == true
  }
  public static var displayName: String { isPreview ? "Autopod Preview" : "Autopod" }
  public static var deepLinkScheme: String { isPreview ? "autopod-preview" : "autopod" }
  public static var credentialService: String {
    isPreview ? "com.autopod.desktop.preview" : "com.autopod.desktop"
  }
  /// Only a directly launched, connected Preview can opt in to a single private origin.
  public static var previewOwnerURL: URL? {
    previewOwnerURL(isConnectedPreview: isPreview && !usesDesignFixtures,
                    arguments: ProcessInfo.processInfo.arguments)
  }

  static func previewOwnerURL(isConnectedPreview: Bool, arguments: [String]) -> URL? {
    let prefix = "--preview-owner-url="
    let flags = arguments.filter { $0.hasPrefix(prefix) }
    guard isConnectedPreview, flags.count == 1, let flag = flags.first,
          let components = URLComponents(string: String(flag.dropFirst(prefix.count))),
          components.scheme == "http", components.host == "127.0.0.1",
          let port = components.port, (1024...65535).contains(port), port != 3100,
          let url = components.url, url.absoluteString == "http://127.0.0.1:\(port)" else { return nil }
    return url
  }

  public static var usesDesignFixtures: Bool {
    isPreview && (Bundle.main.object(forInfoDictionaryKey: "AutopodDesignFixtures") as? String == "YES"
      || ProcessInfo.processInfo.arguments.contains("--design-fixtures"))
  }
}
