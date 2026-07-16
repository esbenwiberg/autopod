import Foundation
import AutopodClient

/// Handles interactive OAuth flows for profile model-provider authentication.
/// Opens Terminal.app with the appropriate CLI tool, polls for the credential artifact,
/// then patches the profile via the daemon API.
public final class ProfileAuthenticator: Sendable {

  public enum PiOAuthProvider: String, CaseIterable, Sendable {
    case anthropic
    case openAICodex = "openai-codex"
    case githubCopilot = "github-copilot"
  }

  private let api: DaemonAPI

  public init(api: DaemonAPI) {
    self.api = api
  }

  // MARK: - Claude MAX / PRO

  /// Authenticate a profile with Claude MAX/PRO via `claude setup-token`.
  /// Opens Terminal.app for the interactive login, then captures the setup token.
  public func authenticateMax(profileName: String) async throws -> String {
    let providerCredentials = try await collectMaxCredentials()

    _ = try await api.patchProfile(profileName, fields: [
      "modelProvider": "max",
      "providerCredentials": providerCredentials,
    ])

    return "Authenticated with Claude MAX/PRO"
  }

  /// Authenticate a shared provider account with Claude MAX/PRO via `claude setup-token`.
  public func authenticateMaxProviderAccount(accountId: String) async throws -> String {
    let providerCredentials = try await collectMaxCredentials()
    _ = try await api.updateProviderAccount(accountId, fields: [
      "credentials": providerCredentials,
    ])
    return "Authenticated provider account with Claude MAX/PRO"
  }

  private func collectMaxCredentials() async throws -> [String: Any] {
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
    defer {
      try? FileManager.default.removeItem(at: home)
      try? FileManager.default.removeItem(at: cwd)
    }
    try runSilent("/usr/bin/git", args: ["init"], cwd: cwd)

    // Resolve claude path
    guard let claudePath = Self.findExecutable("claude") else {
      throw AuthError.cliNotFound("claude")
    }

    // Write a shell script that Terminal.app will run. `script(1)` preserves a
    // pseudo-TTY while capturing output, which keeps `claude setup-token`
    // interactive and still lets Autopod parse the resulting token.
    let markerFile = home.appendingPathComponent(".auth-done")
    let tokenOutputPath = home.appendingPathComponent("setup-token.log")
    let script = """
    #!/bin/bash
    export HOME="\(home.path)"
    unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
    echo ""
    echo "=== Autopod: Claude MAX Authentication ==="
    echo "Follow the Claude setup-token flow in this terminal."
    echo ""
    cd "\(cwd.path)"
    if [ -x /usr/bin/script ]; then
      /usr/bin/script -q "\(tokenOutputPath.path)" "\(claudePath.path)" setup-token
      status=$?
    else
      "\(claudePath.path)" setup-token 2>&1 | tee "\(tokenOutputPath.path)"
      status=${PIPESTATUS[0]}
    fi
    if [ "$status" -eq 0 ]; then
      touch "\(markerFile.path)"
    fi
    echo ""
    if [ "$status" -eq 0 ]; then
      echo "Authentication complete. You can close this window."
    else
      echo "Authentication failed (exit $status). You can close this window."
    fi
    exit "$status"
    """
    let scriptPath = home.appendingPathComponent("auth.sh")
    try script.write(to: scriptPath, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: scriptPath.path
    )

    // Open Terminal.app with the script
    Self.openInTerminal(scriptPath)

    // Poll for completion
    let timeout: TimeInterval = 600 // 10 minutes
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      try await Task.sleep(for: .seconds(2))
      if FileManager.default.fileExists(atPath: markerFile.path) { break }
    }

    let tokenOutput = (try? String(contentsOf: tokenOutputPath, encoding: .utf8)) ?? ""
    guard let oauthToken = Self.extractClaudeOAuthToken(from: tokenOutput) else {
      throw AuthError.noCredentials("No Claude setup token found — login may not have completed.")
    }

    let providerCredentials: [String: Any] = [
      "provider": "max",
      "authMode": "setup-token",
      "oauthToken": oauthToken,
    ]

    return providerCredentials
  }

  // MARK: - OpenAI / ChatGPT

  /// Authenticate a profile with OpenAI Codex via `codex login --device-auth`.
  /// Captures Codex's `auth.json` so pods can run with ChatGPT/Pro auth.
  public func authenticateOpenAI(profileName: String) async throws -> String {
    let providerCredentials = try await collectOpenAICredentials()

    _ = try await api.patchProfile(profileName, fields: [
      "defaultRuntime": "codex",
      "defaultModel": "auto",
      "modelProvider": "openai",
      "providerCredentials": providerCredentials,
    ])

    return "Authenticated with OpenAI Codex"
  }

  /// Authenticate a shared provider account with OpenAI Codex ChatGPT/Pro auth.
  public func authenticateOpenAIProviderAccount(accountId: String) async throws -> String {
    let providerCredentials = try await collectOpenAICredentials()
    _ = try await api.updateProviderAccount(accountId, fields: [
      "credentials": providerCredentials,
    ])
    return "Authenticated provider account with OpenAI Codex"
  }

  private func collectOpenAICredentials() async throws -> [String: Any] {
    let tag = UUID().uuidString.prefix(8)
    let codexHome = FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-codex-auth-\(tag)")
    try FileManager.default.createDirectory(at: codexHome, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.removeItem(at: codexHome)
    }

    guard let codexPath = Self.findExecutable("codex") else {
      throw AuthError.cliNotFound("codex")
    }

    let markerFile = codexHome.appendingPathComponent(".auth-done")
    let script = """
    #!/bin/bash
    export CODEX_HOME="\(codexHome.path)"
    unset OPENAI_API_KEY CODEX_ACCESS_TOKEN
    echo ""
    echo "=== Autopod: OpenAI Codex Authentication ==="
    echo "Follow the device/browser flow to authenticate with ChatGPT."
    echo ""
    "\(codexPath.path)" login --device-auth
    touch "\(markerFile.path)"
    echo ""
    echo "Authentication complete. You can close this window."
    """
    let scriptPath = codexHome.appendingPathComponent("auth.sh")
    try script.write(to: scriptPath, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: scriptPath.path
    )

    Self.openInTerminal(scriptPath)

    let authPath = codexHome.appendingPathComponent("auth.json")
    let timeout: TimeInterval = 600 // 10 minutes
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      try await Task.sleep(for: .seconds(2))
      if FileManager.default.fileExists(atPath: markerFile.path) { break }
      if FileManager.default.fileExists(atPath: authPath.path) { break }
    }

    guard FileManager.default.fileExists(atPath: authPath.path) else {
      throw AuthError.noCredentials("No Codex auth.json found — login may not have completed.")
    }

    let authData = try Data(contentsOf: authPath)
    guard (try JSONSerialization.jsonObject(with: authData)) is [String: Any],
          let authJson = String(data: authData, encoding: .utf8) else {
      throw AuthError.noCredentials("Codex auth.json was not valid JSON.")
    }

    return [
      "provider": "openai",
      "authMode": "chatgpt",
      "authJson": authJson,
    ]
  }

  // MARK: - GitHub Copilot

  /// Authenticate a profile with GitHub Copilot via `copilot login`.
  /// Opens Terminal.app for the interactive login, then reads the token and patches the profile.
  public func authenticateCopilot(profileName: String) async throws -> String {
    let providerCredentials = try await collectCopilotCredentials()

    _ = try await api.patchProfile(profileName, fields: [
      "modelProvider": "copilot",
      "providerCredentials": providerCredentials,
    ])

    return "Authenticated with GitHub Copilot"
  }

  /// Authenticate a shared provider account with GitHub Copilot OAuth.
  public func authenticateCopilotProviderAccount(accountId: String) async throws -> String {
    let providerCredentials = try await collectCopilotCredentials()
    _ = try await api.updateProviderAccount(accountId, fields: [
      "credentials": providerCredentials,
    ])
    return "Authenticated provider account with GitHub Copilot"
  }

  private func collectCopilotCredentials() async throws -> [String: Any] {
    let tag = UUID().uuidString.prefix(8)
    let configDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-copilot-auth-\(tag)")
    try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.removeItem(at: configDir)
    }

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

    return [
      "provider": "copilot",
      "token": authToken,
    ]
  }

  // MARK: - Pi subscriptions

  /// Authenticate one Pi subscription provider. Pi's complete auth bundle is never uploaded.
  public func authenticatePi(
    profileName: String,
    providerId: PiOAuthProvider
  ) async throws -> String {
    let authData = try await collectPiAuthData(providerId: providerId)
    return try await authenticatePi(
      profileName: profileName,
      providerId: providerId,
      authData: authData
    )
  }

  /// Separated from Terminal collection so tests can prove malformed credentials never patch.
  func authenticatePi(
    profileName: String,
    providerId: PiOAuthProvider,
    authData: Data
  ) async throws -> String {
    let providerCredentials = try Self.extractPiCredentials(
      providerId: providerId,
      authData: authData
    )
    _ = try await api.patchProfile(profileName, fields: [
      "defaultRuntime": "pi",
      "modelProvider": "pi",
      "providerCredentials": providerCredentials,
    ])
    return "Authenticated Pi subscription with \(Self.piProviderLabel(providerId))"
  }

  private func collectPiAuthData(providerId: PiOAuthProvider) async throws -> Data {
    let tag = UUID().uuidString.prefix(8)
    let agentDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-pi-auth-\(tag)")
    let cancellationPath = FileManager.default.temporaryDirectory
      .appendingPathComponent("autopod-pi-auth-cancel-\(tag)")
    try FileManager.default.createDirectory(
      at: agentDir,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    defer {
      Self.cancelPiLogin(agentDir: agentDir, cancellationPath: cancellationPath)
    }

    guard let piPath = Self.findExecutable("pi") else {
      throw AuthError.cliNotFound("pi")
    }

    let statusPath = agentDir.appendingPathComponent(".auth-status")
    let script = """
    #!/bin/bash
    export PI_CODING_AGENT_DIR="\(agentDir.path)"
    unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY CODEX_ACCESS_TOKEN
    unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
    echo ""
    echo "=== Autopod: Pi \(Self.piProviderLabel(providerId)) Authentication ==="
    echo "Choose \(providerId.rawValue) in Pi's login flow. Only that provider will be saved."
    \(providerId == .anthropic ? "echo \"Note: Pi Anthropic OAuth uses billed extra usage, not Claude Code plan usage.\"" : "")
    echo ""
    "\(piPath.path)" /login &
    pi_pid=$!
    (
      while [ ! -e "\(cancellationPath.path)" ]; do sleep 0.1; done
      kill -TERM "$pi_pid" 2>/dev/null || true
      for _ in {1..10}; do
        kill -0 "$pi_pid" 2>/dev/null || exit 0
        sleep 0.1
      done
      kill -KILL "$pi_pid" 2>/dev/null || true
    ) &
    watcher_pid=$!
    wait "$pi_pid"
    status=$?
    kill "$watcher_pid" 2>/dev/null || true
    wait "$watcher_pid" 2>/dev/null || true
    echo "$status" > "\(statusPath.path)"
    echo ""
    if [ "$status" -eq 0 ]; then
      echo "Authentication complete. You can close this window."
    else
      echo "Authentication cancelled or failed. You can close this window."
    fi
    exit "$status"
    """
    let scriptPath = agentDir.appendingPathComponent("auth.sh")
    try script.write(to: scriptPath, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: scriptPath.path
    )
    Self.openInTerminal(scriptPath)

    let timeout: TimeInterval = 600
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      try await Task.sleep(for: .seconds(2))
      if FileManager.default.fileExists(atPath: statusPath.path) { break }
    }

    guard let status = try? String(contentsOf: statusPath, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines) else {
      throw AuthError.noCredentials("Pi login did not complete.")
    }
    guard status == "0" else {
      throw AuthError.noCredentials("Pi login was cancelled or failed.")
    }

    let authPath = agentDir.appendingPathComponent("auth.json")
    guard let authData = try? Data(contentsOf: authPath) else {
      throw AuthError.noCredentials("No Pi auth.json found — login may not have completed.")
    }
    return authData
  }

  static func extractPiCredentials(
    providerId: PiOAuthProvider,
    authData: Data
  ) throws -> [String: Any] {
    guard let auth = try? JSONSerialization.jsonObject(with: authData) as? [String: Any],
          let credential = auth[providerId.rawValue] as? [String: Any],
          ["access", "accessToken", "token"].contains(where: {
            (credential[$0] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
          }) else {
      throw AuthError.noCredentials(
        "Pi credentials for \(providerId.rawValue) were missing or malformed."
      )
    }
    return [
      "provider": "pi",
      "providerId": providerId.rawValue,
      "credential": credential,
    ]
  }

  static func cancelPiLogin(agentDir: URL, cancellationPath: URL) {
    // The Terminal process is independent of the Swift task. Its watcher terminates Pi;
    // wait for the shell's status record before deleting secrets so Pi cannot recreate them.
    FileManager.default.createFile(atPath: cancellationPath.path, contents: Data())
    let statusPath = agentDir.appendingPathComponent(".auth-status")
    for _ in 0..<40 {
      if FileManager.default.fileExists(atPath: statusPath.path) { break }
      Thread.sleep(forTimeInterval: 0.05)
    }
    try? FileManager.default.removeItem(at: agentDir)
    try? FileManager.default.removeItem(at: cancellationPath)
  }

  private static func piProviderLabel(_ providerId: PiOAuthProvider) -> String {
    switch providerId {
    case .anthropic: "Anthropic"
    case .openAICodex: "OpenAI Codex"
    case .githubCopilot: "GitHub Copilot"
    }
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

  /// Extract the token from `claude setup-token` output.
  private static func extractClaudeOAuthToken(from output: String) -> String? {
    let patterns = [
      #"CLAUDE_CODE_OAUTH_TOKEN\s*=\s*['"]?([A-Za-z0-9._~+/=-]{32,})"#,
      #"(sk-ant-[A-Za-z0-9._=-]{20,})"#,
      #"(?m)^\s*([A-Za-z0-9._~+/=-]{80,})\s*$"#,
    ]
    for pattern in patterns {
      if let token = firstRegexCapture(pattern, in: output) {
        return token.trimmingCharacters(in: CharacterSet(charactersIn: "'\" \t\r\n"))
      }
    }
    return nil
  }

  private static func firstRegexCapture(_ pattern: String, in text: String) -> String? {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let match = regex.firstMatch(in: text, range: range), match.numberOfRanges > 1 else {
      return nil
    }
    let captureRange = match.range(at: 1)
    guard let swiftRange = Range(captureRange, in: text) else { return nil }
    return String(text[swiftRange])
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
