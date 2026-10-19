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
  public static var usesDesignFixtures: Bool {
    isPreview && (Bundle.main.object(forInfoDictionaryKey: "AutopodDesignFixtures") as? String == "YES"
      || ProcessInfo.processInfo.arguments.contains("--design-fixtures"))
  }
}
