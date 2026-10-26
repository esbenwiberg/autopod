import AutopodClient
import SwiftUI

/// Tokens are transient write-only state, never part of a configuration draft or JSON editor.
struct PackageFeedEditor: View {
  @Binding var payload: [String: ConfigurationJSON]
  let document: ConfigurationDocument?
  let actions: LaunchConfigurationActions
  @State private var credentials: [ConfigurationJSON] = []
  @State private var token = ""
  @State private var busy = false
  @State private var message: String?
  @State private var confirmRotation = false

  private var credentialID: String { payload["credential"]?["secretId"]?.string ?? "" }
  private var selectedCredential: ConfigurationJSON? { credentials.first { $0["id"]?.string == credentialID } }
  private var origin: String? {
    guard let url = URL(string: payload["url"]?.string ?? ""), url.scheme == "https", let host = url.host,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
    return "https://\(host.lowercased())\(url.port.flatMap { $0 == 443 ? nil : ":\($0)" } ?? "")"
  }
  private var users: [String] {
    actions.list(.repository).filter { repo in
      (repo.payload["setups"]?.array ?? []).contains { setup in
        let integrations = setup["integrations"]
        let sharedFeedIDs = actions.list(.packageFeed).filter { feed in
          feed.id == document?.id || (!credentialID.isEmpty && feed.payload["credential"]?["secretId"]?.string == credentialID)
        }.map(\.id)
        return sharedFeedIDs.contains { integrations?["packageFeedIds"]?.array?.contains(.string($0)) ?? false }
          || (!credentialID.isEmpty && (integrations?["privateRegistries"]?.array ?? []).contains { $0["credential"]?["secretId"]?.string == credentialID })
      }
    }.map(\.name)
  }
  private func text(_ key: String, optional: Bool = false) -> Binding<String> {
    Binding(get: { payload[key]?.string ?? "" }, set: { value in
      if value.isEmpty && optional { payload.removeValue(forKey: key) }
      else { payload[key] = .string(value) }
    })
  }
  var body: some View {
    ConfigurationSection(title: "Package feed", subtitle: "Shared installation infrastructure, not agent tools. PATs stay encrypted on the daemon.") {
      Picker("Type", selection: text("type")) { Text("npm").tag("npm"); Text("NuGet").tag("nuget") }
        .onChange(of: payload["type"]) { _, value in if value?.string == "nuget" { payload.removeValue(forKey: "scope") } }
      TextField("HTTPS registry URL", text: text("url")).accessibilityIdentifier("feed-url")
      if payload["type"]?.string == "npm" { TextField("npm scope (optional, e.g. @company)", text: text("scope", optional: true)) }
      TextField("PAT expiry YYYY-MM-DD (optional)", text: Binding(get: { payload["expiresAt"]?.string ?? "" }, set: { payload["expiresAt"] = $0.isEmpty ? .null : .string($0) }))
      if let warning = Self.expiryWarning(payload["expiresAt"]?.string) { Text(warning).foregroundStyle(.orange) }
      Text("Expiry is an operator reminder, not proof the provider accepts the credential.").font(.caption).foregroundStyle(.secondary)
      Picker("Registry credential", selection: Binding(get: { credentialID }, set: { payload["credential"] = $0.isEmpty ? .null : .object(["secretId": .string($0)]) })) {
        Text("Create new credential").tag("")
        ForEach(credentials.filter { item in
          item["revoked"]?.bool != true && (item["purposes"]?.array?.contains(.string("registry-read")) ?? false)
            && (origin.map { item["origins"]?.array?.contains(.string($0)) ?? false } ?? false)
        }, id: \.self) { item in Text(item["name"]?.string ?? item["id"]?.string ?? "Credential").tag(item["id"]?.string ?? "") }
        if !credentialID.isEmpty && !credentials.contains(where: { $0["id"]?.string == credentialID }) { Text("Unavailable: \(credentialID)").tag(credentialID) }
      }.accessibilityIdentifier("feed-credential")
      Text("Used by: \(users.isEmpty ? "No saved repository selections" : users.joined(separator: ", "))").font(.caption)
      Text("Rotation affects every feed/repository using this credential, including legacy inline registries. It takes effect immediately and is not undone by Cancel.").font(.caption).foregroundStyle(.secondary)
      SecureField(credentialID.isEmpty ? "New PAT (Packaging: Read)" : "Replacement PAT", text: $token)
        .accessibilityIdentifier("feed-pat")
      Button(credentialID.isEmpty ? "Store PAT securely" : "Rotate shared PAT…") {
        if credentialID.isEmpty { Task { await storeToken() } } else { confirmRotation = true }
      }.disabled(busy || token.isEmpty || origin == nil || (!credentialID.isEmpty && selectedCredential == nil))
        .accessibilityIdentifier("feed-store-pat")
      Text("After storing a new PAT, Save this feed to retain its reference. Tokens are never shown again.").font(.caption).foregroundStyle(.secondary)
      if let document {
        Button("Test saved connection") { Task { await test(document) } }
          .disabled(busy || document.payload != payload || credentialID.isEmpty)
          .accessibilityIdentifier("feed-test")
          .help("Save and reopen the feed before testing changed settings.")
      } else { Text("Save the feed first to test its connection.").font(.caption) }
      Text("After rotating a blocked pod’s PAT, reply to its blocker to continue. Autopod refreshes the existing frozen registry bindings before resuming; rotation alone never resumes work.").font(.caption).foregroundStyle(.secondary)
      if busy { ProgressView().controlSize(.small) }
      if let message { Text(message).font(.callout).textSelection(.enabled) }
    }
    .task { await reloadCredentials() }
    .onDisappear { token = "" }
    .confirmationDialog("Rotate this shared credential now?", isPresented: $confirmRotation) {
      Button("Rotate PAT", role: .destructive) { Task { await storeToken() } }
      Button("Cancel", role: .cancel) {}
    } message: { Text("All references to this credential will use the replacement on their next credential refresh. Existing pods are not automatically resumed.") }
  }

  static func expiryWarning(_ date: String?, now: Date = Date()) -> String? {
    guard let date, !date.isEmpty else { return nil }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
    guard let expiry = formatter.date(from: date), formatter.string(from: expiry) == date else { return "Enter a valid expiry date (YYYY-MM-DD)." }
    if expiry.addingTimeInterval(86_400) <= now { return "PAT expiry date has passed. Rotate the credential before continuing work." }
    if expiry.timeIntervalSince(now) < 7 * 86_400 { return "PAT expires within 7 days." }
    return nil
  }

  private func reloadCredentials() async {
    do { credentials = try await actions.listRegistryCredentials() }
    catch { message = "Could not load credential metadata. Refresh before changing credentials." }
  }
  private func storeToken() async {
    guard let origin, !busy, !token.isEmpty else { return }
    busy = true; defer { busy = false; token = "" }
    do {
      let result: ConfigurationJSON
      if credentialID.isEmpty {
        result = try await actions.saveRegistryCredential(nil, .object([
          "name": .string("\(document?.name ?? "Package feed") \(UUID().uuidString.prefix(8))"),
          "purposes": .array([.string("registry-read")]), "origins": .array([.string(origin)]), "value": .string(token),
        ]))
      } else {
        guard let revision = selectedCredential?["revision"]?.number else { message = "Reload credential metadata before rotating."; return }
        result = try await actions.saveRegistryCredential(credentialID, .object(["expectedRevision": .number(revision), "value": .string(token)]))
      }
      if let id = result["id"]?.string { payload["credential"] = .object(["secretId": .string(id)]) }
      message = "Credential stored. Save the feed’s reference and expiry. No pod was resumed."
      await reloadCredentials()
    } catch {
      // Never render raw credential-request diagnostics: an upstream rejection may contain input.
      message = "Credential save was not confirmed. Reload metadata before retrying; do not assume the old value remains."
      await reloadCredentials()
    }
  }
  private func test(_ document: ConfigurationDocument) async {
    busy = true; defer { busy = false }
    do { message = try await actions.testPackageFeed(document.id, document.revision)["message"]?.string ?? "No test result." }
    catch { message = "Connection test could not complete. Refresh the saved feed and credential metadata before retrying." }
  }
}
