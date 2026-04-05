import Foundation
import AutopodClient

/// Handles interactive OAuth flows for profile model-provider authentication.
/// Opens Terminal.app with the appropriate CLI tool, polls for the credentials file,
/// then patches the profile via the daemon API.
public final class ProfileAuthenticator: Sendable {

  private let api: DaemonAPI

  public init(api: DaemonAPI) {
    self.api = api
  }

  // MARK: - Claude MAX / PRO

  /// Authenticate a profile with Claude MAX/PRO via `claude` CLI OAuth.
  /// Opens Terminal.app for the interactive login, then reads credentials and patches the profile.
  public func authenticateMax(profileName: String) async throws -> String {
    let tag = UUID().uuidString.prefix(8)
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-auth-\(tag)")
    let claudeDir = home.appendingPathComponent(".claude")
    try FileManager.default.createDirectory(at: claudeDir, withIntermediateDirectories: true)

    // Suppress first-run prompts
    let configData = try JSONSerialization.data(
      withJSONObject: ["hasCompletedOnboarding": true, "theme": "dark"]
    )
    try configData.write(to: claudeDir.appendingPathComponent(".config.json"))

    // Working dir (claude needs a git repo context)
    let cwd = FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-auth-cwd-\(tag)")
    try FileManager.default.createDirectory(at: cwd, withIntermediateDirectories: true)
    try runSilent("/usr/bin/git", args: ["init"], cwd: cwd)

    // Resolve claude path
    guard let claudePath = Self.findExecutable("claude") else {
      throw AuthError.cliNotFound("claude")
    }

    // Write a shell script that Terminal.app will run
    let markerFile = home.appendingPathComponent(".auth-done")
    let script = """
    #!/bin/bash
    export HOME="\(home.path)"
    echo ""
    echo "=== Autopod: Claude MAX Authentication ==="
    echo "Type /login to start OAuth, then /exit when done."
    echo ""
    cd "\(cwd.path)"
    "\(claudePath.path)"
    touch "\(markerFile.path)"
    echo ""
    echo "Authentication complete. You can close this window."
    """
    let scriptPath = home.appendingPathComponent("auth.sh")
    try script.write(to: scriptPath, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: scriptPath.path
    )

    // Open Terminal.app with the script
    Self.openInTerminal(scriptPath)

    // Poll for completion (marker file or credentials file)
    let credsPath = claudeDir.appendingPathComponent(".credentials.json")
    let timeout: TimeInterval = 600 // 10 minutes
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      try await Task.sleep(for: .seconds(2))
      if FileManager.default.fileExists(atPath: markerFile.path) { break }
      if FileManager.default.fileExists(atPath: credsPath.path) { break }
    }

    guard FileManager.default.fileExists(atPath: credsPath.path) else {
      throw AuthError.noCredentials("No credentials file found — login may not have completed.")
    }

    let credsData = try Data(contentsOf: credsPath)
    guard let creds = try JSONSerialization.jsonObject(with: credsData) as? [String: Any],
          let oauth = creds["claudeAiOauth"] as? [String: Any],
          let accessToken = oauth["accessToken"] as? String,
          let refreshToken = oauth["refreshToken"] as? String else {
      throw AuthError.noCredentials("Credentials file missing OAuth tokens.")
    }

    let expiresAt: String
    if let ts = oauth["expiresAt"] as? TimeInterval {
      expiresAt = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: ts / 1000))
    } else {
      expiresAt = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: 3600))
    }

    var providerCredentials: [String: Any] = [
      "provider": "max",
      "accessToken": accessToken,
      "refreshToken": refreshToken,
      "expiresAt": expiresAt,
    ]
    if let scopes = oauth["scopes"] { providerCredentials["scopes"] = scopes }
    if let sub = oauth["subscriptionType"] { providerCredentials["subscriptionType"] = sub }
    if let tier = oauth["rateLimitTier"] { providerCredentials["rateLimitTier"] = tier }

    _ = try await api.patchProfile(profileName, fields: [
      "modelProvider": "max",
      "providerCredentials": providerCredentials,
    ])

    try? FileManager.default.removeItem(at: home)
    try? FileManager.default.removeItem(at: cwd)

    return "Authenticated with Claude MAX/PRO"
  }

  // MARK: - GitHub Copilot

  /// Authenticate a profile with GitHub Copilot via `copilot login`.
  /// Opens Terminal.app for the interactive login, then reads the token and patches the profile.
  public func authenticateCopilot(profileName: String) async throws -> String {
    let tag = UUID().uuidString.prefix(8)
    let configDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-copilot-auth-\(tag)")
    try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)

    guard let copilotPath = Self.findExecutable("copilot") else {
      throw AuthError.cliNotFound("copilot")
    }

    let markerFile = configDir.appendingPathComponent(".auth-done")
    let script = """
    #!/bin/bash
    unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
    echo ""
    echo "=== Autopod: GitHub Copilot Authentication ==="
    echo "Follow the browser OAuth flow to authenticate."
    echo ""
    "\(copilotPath.path)" login --config-dir "\(configDir.path)"
    touch "\(markerFile.path)"
    echo ""
    echo "Authentication complete. You can close this window."
    """
    let scriptPath = configDir.appendingPathComponent("auth.sh")
    try script.write(to: scriptPath, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: scriptPath.path
    )

    Self.openInTerminal(scriptPath)

    // Poll for completion
    let timeout: TimeInterval = 300 // 5 minutes
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      try await Task.sleep(for: .seconds(2))
      if FileManager.default.fileExists(atPath: markerFile.path) { break }
    }

    // Read token from file
    var authToken: String?

    let credsPath = configDir.appendingPathComponent("github.com.tokens.json")
    if let data = try? Data(contentsOf: credsPath),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let t = json["token"] as? String {
      authToken = t
    }

    // macOS Keychain fallback
    if authToken == nil {
      authToken = Self.readKeychainPassword(service: "copilot-cli")
    }

    guard let authToken else {
      throw AuthError.noCredentials("No token found — login may not have completed.")
    }

    _ = try await api.patchProfile(profileName, fields: [
      "modelProvider": "copilot",
      "providerCredentials": [
        "provider": "copilot",
        "token": authToken,
      ] as [String: Any],
    ])

    try? FileManager.default.removeItem(at: configDir)

    return "Authenticated with GitHub Copilot"
  }

  // MARK: - Types

  public enum AuthError: LocalizedError, Sendable {
    case noCredentials(String)
    case cliNotFound(String)

    public var errorDescription: String? {
      switch self {
      case .noCredentials(let msg): msg
      case .cliNotFound(let name):
        "\(name) CLI not found. Install it and make sure it's in your PATH."
      }
    }
  }

  // MARK: - Helpers

  /// Open a shell script in Terminal.app.
  private static func openInTerminal(_ scriptPath: URL) {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    proc.arguments = ["-a", "Terminal", scriptPath.path]
    try? proc.run()
    proc.waitUntilExit()
  }

  /// Run a command silently (no output).
  private func runSilent(_ path: String, args: [String], cwd: URL) throws {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: path)
    proc.arguments = args
    proc.currentDirectoryURL = cwd
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try proc.run()
    proc.waitUntilExit()
  }

  /// Read a password from the macOS Keychain.
  private static func readKeychainPassword(service: String) -> String? {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    proc.arguments = ["find-generic-password", "-s", service, "-w"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()
    guard proc.terminationStatus == 0 else { return nil }
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Find an executable by checking the user's login shell PATH and common install locations.
  /// GUI apps don't inherit the shell PATH, so we resolve it explicitly via `login -f`.
  private static func findExecutable(_ name: String) -> URL? {
    // Ask the user's login shell for the full PATH — GUI apps get a minimal one
    if let path = resolveViaLoginShell(name) {
      return URL(fileURLWithPath: path)
    }

    // Well-known install locations (Homebrew, npm global, Claude app bundle, ~/.local)
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
      "/opt/homebrew/bin/\(name)",
      "/usr/local/bin/\(name)",
      "\(home)/.local/bin/\(name)",
      "\(home)/.npm/bin/\(name)",
      "\(home)/.claude/bin/\(name)",
      // Claude Code installed via the desktop app (cmux)
      "/Applications/cmux.app/Contents/Resources/bin/\(name)",
      "/Applications/Claude.app/Contents/Resources/bin/\(name)",
    ]
    for p in candidates {
      if FileManager.default.isExecutableFile(atPath: p) {
        return URL(fileURLWithPath: p)
      }
    }

    return nil
  }

  /// Resolve an executable path using the user's login shell to get the full PATH.
  private static func resolveViaLoginShell(_ name: String) -> String? {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: shell)
    // -l = login shell (loads ~/.zprofile, ~/.zshrc, etc. which set PATH)
    // -c = run command
    proc.arguments = ["-l", "-c", "which \(name)"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
    proc.waitUntilExit()

    guard proc.terminationStatus == 0 else { return nil }
    let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return (output?.isEmpty == false) ? output : nil
  }
}
