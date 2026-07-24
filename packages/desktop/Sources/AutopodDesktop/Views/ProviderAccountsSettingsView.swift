import SwiftUI
import AutopodClient
import AutopodUI

struct ProviderAccountsSettingsView: View {
  let api: DaemonAPI?
  let profiles: [Profile]
  let onProfilesChanged: (() async -> Void)?

  @State private var accounts: [PublicProviderAccountResponse] = []
  @State private var providerCatalog: ProviderCatalogResponse?
  @State private var isLoading = false
  @State private var errorMessage: String?
  @State private var showCreateSheet = false
  @State private var showImportSheet = false
  @State private var inFlightAction: String?
  @State private var deleteTarget: PublicProviderAccountResponse?
  @State private var apiKeyTarget: PublicProviderAccountResponse?

  private var sortedAccounts: [PublicProviderAccountResponse] {
    accounts.sorted {
      if $0.provider == $1.provider { return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
      return $0.provider < $1.provider
    }
  }

  private var profilesWithLegacyCredentials: [Profile] {
    profiles
      .filter { $0.providerCredentialsType != nil }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header

      if let errorMessage {
        errorBanner(errorMessage)
      }

      if api == nil {
        unavailableState
      } else if isLoading && accounts.isEmpty {
        Spacer()
        ProgressView()
          .frame(maxWidth: .infinity)
        Spacer()
      } else if accounts.isEmpty {
        emptyState
      } else {
        ScrollView {
          VStack(spacing: 8) {
            ForEach(sortedAccounts, id: \.id) { account in
              accountRow(account)
            }
          }
          .padding(.bottom, 4)
        }
      }
    }
    .padding(20)
    .task(id: api?.baseURL.absoluteString ?? "none") {
      await loadAccounts()
    }
    .sheet(isPresented: $showCreateSheet) {
      ProviderAccountCreateSheet(
        isPresented: $showCreateSheet,
        providers: providerCatalog?.providers ?? []
      ) { name, provider, id, apiKey in
        try await createAccount(name: name, provider: provider, id: id, apiKey: apiKey)
      }
    }
    .sheet(isPresented: $showImportSheet) {
      ProviderAccountImportSheet(
        isPresented: $showImportSheet,
        profiles: profilesWithLegacyCredentials
      ) { profileName, accountId, accountName, clearLegacyCredentials in
        try await importAccount(
          profileName: profileName,
          accountId: accountId,
          accountName: accountName,
          clearLegacyCredentials: clearLegacyCredentials
        )
      }
    }
    .sheet(
      isPresented: Binding(
        get: { apiKeyTarget != nil },
        set: { if !$0 { apiKeyTarget = nil } }
      )
    ) {
      if let account = apiKeyTarget,
         let provider = providerCatalog?.provider(id: account.provider) {
        ProviderAPIKeySheet(
          isPresented: Binding(
            get: { apiKeyTarget != nil },
            set: { if !$0 { apiKeyTarget = nil } }
          ),
          accountName: account.name,
          provider: provider
        ) { apiKey in
          try await replaceAPIKey(account, apiKey: apiKey)
        }
      }
    }
    .alert(
      "Delete Provider Account",
      isPresented: Binding(
        get: { deleteTarget != nil },
        set: { if !$0 { deleteTarget = nil } }
      )
    ) {
      Button("Cancel", role: .cancel) { deleteTarget = nil }
      Button("Delete", role: .destructive) {
        let target = deleteTarget
        deleteTarget = nil
        if let target {
          Task { await deleteAccount(target) }
        }
      }
    } message: {
      Text("Delete \(deleteTarget?.name ?? "this provider account")?")
    }
  }

  private var header: some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Provider Accounts")
          .font(.title3.weight(.semibold))
        Text("Shared model-provider authentication.")
          .font(.callout)
          .foregroundStyle(.secondary)
      }
      Spacer()
      Button {
        Task { await loadAccounts() }
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(.borderless)
      .disabled(api == nil || isLoading)
      .help("Refresh provider accounts")

      Button {
        showImportSheet = true
      } label: {
        Label("Import", systemImage: "square.and.arrow.down")
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .disabled(api == nil || profilesWithLegacyCredentials.isEmpty)
      .help("Import credentials from a profile")

      Button {
        showCreateSheet = true
      } label: {
        Label("New", systemImage: "plus")
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.small)
      .disabled(api == nil || providerCatalog == nil)
      .help(
        providerCatalog == nil
          ? "Refresh the provider catalog before creating an account"
          : "Create provider account"
      )
    }
  }

  private var unavailableState: some View {
    VStack(spacing: 8) {
      Spacer()
      Image(systemName: "server.rack")
        .font(.title2)
        .foregroundStyle(.tertiary)
      Text("Connect to a daemon")
        .font(.callout.weight(.medium))
      Spacer()
    }
    .frame(maxWidth: .infinity)
  }

  private var emptyState: some View {
    VStack(spacing: 8) {
      Spacer()
      Image(systemName: "person.2.badge.key")
        .font(.title2)
        .foregroundStyle(.tertiary)
      Text("No provider accounts")
        .font(.callout.weight(.medium))
      Spacer()
    }
    .frame(maxWidth: .infinity)
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.yellow)
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Spacer()
      Button {
        errorMessage = nil
      } label: {
        Image(systemName: "xmark.circle.fill")
          .foregroundStyle(.tertiary)
      }
      .buttonStyle(.borderless)
    }
    .padding(8)
    .background(Color.red.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: 6))
  }

  private func accountRow(_ account: PublicProviderAccountResponse) -> some View {
    let linkedProfiles = profiles
      .filter { $0.providerAccountId == account.id }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    let linkableProfiles = profiles
      .filter { profile in
        guard profile.providerAccountId != account.id else { return false }
        return providerCatalog?.provider(id: account.provider)?
          .isCompatible(profileProviderId: profile.modelProvider.rawValue)
          ?? (profile.modelProvider.rawValue == account.provider)
      }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

    return VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: providerIcon(account.provider))
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(.blue)
          .frame(width: 22)

        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 6) {
            Text(account.name)
              .font(.callout.weight(.semibold))
              .lineLimit(1)
            providerBadge(account.provider)
            authBadge(account)
          }
          Text(account.id)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }

        Spacer()

        if inFlightAction?.hasSuffix(":\(account.id)") == true {
          ProgressView()
            .scaleEffect(0.65)
            .frame(width: 18, height: 18)
        }

        authControl(account)

        Menu {
          if linkableProfiles.isEmpty {
            Text("No matching profiles")
          } else {
            ForEach(linkableProfiles) { profile in
              Button(profile.name) {
                Task { await link(account, profileName: profile.name) }
              }
            }
          }
        } label: {
          Image(systemName: "link")
        }
        .menuStyle(.borderlessButton)
        .disabled(isAccountBusy(account.id) || linkableProfiles.isEmpty)
        .help("Link profile")

        Button {
          deleteTarget = account
        } label: {
          Image(systemName: "trash")
            .foregroundStyle(linkedProfiles.isEmpty ? Color.red.opacity(0.7) : Color.secondary.opacity(0.45))
        }
        .buttonStyle(.borderless)
        .disabled(isAccountBusy(account.id) || !linkedProfiles.isEmpty)
        .help(linkedProfiles.isEmpty ? "Delete provider account" : "Unlink profiles before deleting")
      }

      if !linkedProfiles.isEmpty {
        linkedProfilesRow(linkedProfiles)
      }

      if let provider = providerCatalog?.provider(id: account.provider) {
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: provider.policy.runnable ? "checkmark.shield" : "hand.raised.fill")
          VStack(alignment: .leading, spacing: 2) {
            Text(provider.policy.runnable
              ? "Supported for unattended pods"
              : "Not runnable — \(provider.policy.authorization)")
            ForEach(provider.policy.caveats, id: \.message) { caveat in
              Text("\(caveat.kind.capitalized): \(caveat.message)")
            }
          }
          Spacer()
        }
        .font(.caption2)
        .foregroundStyle(provider.policy.runnable ? Color.secondary : Color.orange)
      }

      metadataRow(account)
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
    )
  }

  private func linkedProfilesRow(_ linkedProfiles: [Profile]) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("Profiles")
        .font(.caption2)
        .foregroundStyle(.tertiary)
      ForEach(linkedProfiles) { profile in
        HStack(spacing: 4) {
          Text(profile.name)
            .font(.system(.caption, design: .monospaced))
            .lineLimit(1)
          Button {
            Task { await unlink(profileName: profile.name) }
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
          .buttonStyle(.borderless)
          .help("Unlink \(profile.name)")
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(.quaternary.opacity(0.55), in: Capsule())
      }
      Spacer()
    }
  }

  private func metadataRow(_ account: PublicProviderAccountResponse) -> some View {
    HStack(spacing: 10) {
      if let lastAuthenticatedAt = account.lastAuthenticatedAt {
        Label(lastAuthenticatedAt, systemImage: "checkmark.seal")
      }
      if let lastUsedAt = account.lastUsedAt {
        Label(lastUsedAt, systemImage: "clock")
      }
      Spacer()
    }
    .font(.caption2)
    .foregroundStyle(.tertiary)
  }

  private func providerBadge(_ provider: String) -> some View {
    Text(providerLabel(provider))
      .font(.caption2.weight(.medium))
      .foregroundStyle(.secondary)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(.quaternary.opacity(0.55), in: Capsule())
  }

  private func authBadge(_ account: PublicProviderAccountResponse) -> some View {
    HStack(spacing: 3) {
      Image(systemName: account.hasCredentials ? "checkmark.circle.fill" : "circle")
      Text(account.hasCredentials ? "Auth" : "No creds")
    }
    .font(.caption2.weight(.medium))
    .foregroundStyle(account.hasCredentials ? .green : .secondary)
  }

  private func isAccountBusy(_ id: String) -> Bool {
    inFlightAction?.hasSuffix(":\(id)") == true
  }

  @MainActor
  private func loadAccounts() async {
    guard let api else {
      accounts = []
      return
    }
    isLoading = true
    defer { isLoading = false }
    do {
      async let loadedAccounts = api.listProviderAccounts()
      async let loadedCatalog = api.fetchModelProviderCatalog()
      accounts = try await loadedAccounts
      providerCatalog = try await loadedCatalog
      errorMessage = nil
    } catch {
      let failure = ProviderAccountsCatalogFailure(
        preserving: accounts,
        error: error
      )
      accounts = failure.accounts
      providerCatalog = failure.catalog
      errorMessage = failure.errorMessage
    }
  }

  @MainActor
  private func createAccount(
    name: String,
    provider: String,
    id: String?,
    apiKey: String?
  ) async throws {
    guard let api else { throw DaemonError.networkError("Not connected to daemon") }
    guard let catalogProvider = providerCatalog?.provider(id: provider) else {
      throw DaemonError.badRequest("Provider catalog unavailable. Refresh before creating an account.")
    }
    guard catalogProvider.policy.authorization == "supported", catalogProvider.policy.runnable else {
      throw DaemonError.badRequest(
        "\(catalogProvider.displayName) is \(catalogProvider.policy.authorization) and cannot accept credentials."
      )
    }
    if catalogProvider.implementation.kind == "generic-pi-api",
       !catalogProvider.canAcceptGenericAPIKey {
      throw DaemonError.badRequest(
        "\(catalogProvider.displayName) does not advertise API-key authentication."
      )
    }
    _ = try await api.createProviderAccount(
      name: name,
      provider: provider,
      id: id,
      apiKey: catalogProvider.canAcceptGenericAPIKey ? apiKey : nil
    )
    await loadAccounts()
  }

  @MainActor
  private func importAccount(
    profileName: String,
    accountId: String?,
    accountName: String?,
    clearLegacyCredentials: Bool
  ) async throws {
    guard let api else { throw DaemonError.networkError("Not connected to daemon") }
    _ = try await api.importProviderAccountFromProfile(
      profileName: profileName,
      accountId: accountId,
      accountName: accountName,
      clearLegacyCredentials: clearLegacyCredentials
    )
    await onProfilesChanged?()
    await loadAccounts()
  }

  @MainActor
  private func authenticate(_ account: PublicProviderAccountResponse) async {
    guard let api else { return }
    inFlightAction = "auth:\(account.id)"
    defer { inFlightAction = nil }
    do {
      let authenticator = ProfileAuthenticator(api: api)
      switch account.provider {
      case "max":
        _ = try await authenticator.authenticateMaxProviderAccount(accountId: account.id)
      case "openai":
        _ = try await authenticator.authenticateOpenAIProviderAccount(accountId: account.id)
      case "copilot":
        _ = try await authenticator.authenticateCopilotProviderAccount(accountId: account.id)
      default:
        throw DaemonError.badRequest("Desktop authentication is not available for \(providerLabel(account.provider)).")
      }
      await loadAccounts()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func authenticatePi(
    _ account: PublicProviderAccountResponse,
    providerId: ProfileAuthenticator.PiOAuthProvider
  ) async {
    guard let api else { return }
    inFlightAction = "auth:\(account.id)"
    defer { inFlightAction = nil }
    do {
      let authenticator = ProfileAuthenticator(api: api)
      _ = try await authenticator.authenticatePiProviderAccount(
        accountId: account.id,
        providerId: providerId
      )
      await loadAccounts()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func replaceAPIKey(
    _ account: PublicProviderAccountResponse,
    apiKey: String
  ) async throws {
    guard let api else { throw DaemonError.networkError("Not connected to daemon") }
    guard let provider = providerCatalog?.provider(id: account.provider),
          provider.canAcceptGenericAPIKey else {
      throw DaemonError.badRequest(
        "Provider catalog unavailable or \(providerLabel(account.provider)) cannot accept API keys."
      )
    }
    inFlightAction = "auth:\(account.id)"
    defer { inFlightAction = nil }
    _ = try await api.updateProviderAccount(account.id, fields: [
      "credentials": [
        "provider": "api-key",
        "providerId": account.provider,
        "apiKey": apiKey,
      ],
    ])
    await loadAccounts()
  }

  @MainActor
  private func link(_ account: PublicProviderAccountResponse, profileName: String) async {
    guard let api else { return }
    inFlightAction = "link:\(account.id)"
    defer { inFlightAction = nil }
    do {
      _ = try await api.linkProviderAccount(account.id, profileName: profileName)
      await onProfilesChanged?()
      await loadAccounts()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func unlink(profileName: String) async {
    guard let api else { return }
    inFlightAction = "unlink:\(profileName)"
    defer { inFlightAction = nil }
    do {
      try await api.unlinkProviderAccount(profileName: profileName)
      await onProfilesChanged?()
      await loadAccounts()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func deleteAccount(_ account: PublicProviderAccountResponse) async {
    guard let api else { return }
    inFlightAction = "delete:\(account.id)"
    defer { inFlightAction = nil }
    do {
      try await api.deleteProviderAccount(account.id)
      await loadAccounts()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func canAuthenticate(_ provider: String) -> Bool {
    provider == "max" || provider == "openai" || provider == "copilot" || provider == "pi"
  }

  private func providerLabel(_ provider: String) -> String {
    if let label = providerCatalog?.provider(id: provider)?.displayName {
      return label
    }
    switch provider {
    case "anthropic": "Anthropic"
    case "max": "Claude Max"
    case "openai": "OpenAI"
    case "foundry": "Foundry"
    case "copilot": "Copilot"
    case "openrouter": "OpenRouter"
    case "pi": "Pi"
    default: provider
    }
  }

  private func providerIcon(_ provider: String) -> String {
    if let icon = providerCatalog?.provider(id: provider)?.systemImage {
      return icon
    }
    switch provider {
    case "anthropic", "max": "sparkles"
    case "openai", "openrouter": "cpu"
    case "foundry": "building.2"
    case "copilot": "keyboard"
    case "pi": "sparkle.magnifyingglass"
    default: "person.badge.key"
    }
  }

  @ViewBuilder
  private func authControl(_ account: PublicProviderAccountResponse) -> some View {
    if providerCatalog?.provider(id: account.provider)?.canAcceptGenericAPIKey == true {
      Button {
        apiKeyTarget = account
      } label: {
        Image(systemName: account.hasCredentials ? "arrow.triangle.2.circlepath" : "person.badge.key")
      }
      .buttonStyle(.borderless)
      .disabled(isAccountBusy(account.id))
      .help(account.hasCredentials ? "Replace API key" : "Add API key")
    } else if account.provider == "pi" {
      Menu {
        ForEach(ProfileAuthenticator.PiOAuthProvider.allCases, id: \.rawValue) { providerId in
          Button(piProviderLabel(providerId)) {
            Task { await authenticatePi(account, providerId: providerId) }
          }
        }
      } label: {
        Image(systemName: account.hasCredentials ? "arrow.triangle.2.circlepath" : "person.badge.key")
      }
      .menuStyle(.borderlessButton)
      .disabled(isAccountBusy(account.id))
      .help(account.hasCredentials ? "Re-authenticate with Pi" : "Authenticate with Pi")
    } else if canAuthenticate(account.provider) {
      Button {
        Task { await authenticate(account) }
      } label: {
        Image(systemName: account.hasCredentials ? "arrow.triangle.2.circlepath" : "person.badge.key")
      }
      .buttonStyle(.borderless)
      .disabled(isAccountBusy(account.id))
      .help(account.hasCredentials ? "Re-authenticate" : "Authenticate")
    }
  }

  private func piProviderLabel(_ providerId: ProfileAuthenticator.PiOAuthProvider) -> String {
    switch providerId {
    case .anthropic: "Anthropic"
    case .openAICodex: "OpenAI Codex"
    case .githubCopilot: "GitHub Copilot"
    }
  }
}

private struct ProviderAPIKeySheet: View {
  @Binding var isPresented: Bool
  let accountName: String
  let provider: ProviderCatalogProvider
  let onSave: (String) async throws -> Void

  @State private var apiKey = ""
  @State private var isSaving = false
  @State private var errorMessage: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Replace \(provider.displayName) API Key")
        .font(.headline)
      Text("Enter a new key for \(accountName). The stored secret is never displayed.")
        .font(.callout)
        .foregroundStyle(.secondary)

      if let guidance = provider.credentialOptions.first?.acquisition {
        Text(guidance)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
      }

      SecureField(provider.credentialOptions.first?.label ?? "API key", text: $apiKey)
        .textFieldStyle(.roundedBorder)

      HStack {
        Spacer()
        Button("Cancel") { isPresented = false }
          .keyboardShortcut(.cancelAction)
        Button("Save") {
          Task { await save() }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
      }
    }
    .padding(20)
    .frame(width: 420)
  }

  @MainActor
  private func save() async {
    let secret = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !secret.isEmpty else { return }
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }
    do {
      try await onSave(secret)
      apiKey = ""
      isPresented = false
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct ProviderAccountCreateSheet: View {
  @Binding var isPresented: Bool
  let providers: [ProviderCatalogProvider]
  let onCreate: (String, String, String?, String?) async throws -> Void

  @State private var name = ""
  @State private var accountId = ""
  @State private var provider = "openai"
  @State private var apiKey = ""
  @State private var isSaving = false
  @State private var errorMessage: String?

  private var selectedProvider: ProviderCatalogProvider? {
    providers.first { $0.id == provider }
  }

  private var trimmedName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var trimmedId: String? {
    let value = accountId.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("New Provider Account")
        .font(.headline)

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }

      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
        GridRow {
          Text("Name")
            .foregroundStyle(.secondary)
          TextField("Team OpenAI", text: $name)
            .textFieldStyle(.roundedBorder)
            .frame(width: 260)
        }
        GridRow {
          Text("ID")
            .foregroundStyle(.secondary)
          TextField("team-openai", text: $accountId)
            .textFieldStyle(.roundedBorder)
            .font(.system(.body, design: .monospaced))
            .frame(width: 260)
        }
        GridRow {
          Text("Provider")
            .foregroundStyle(.secondary)
          Picker("", selection: $provider) {
            ForEach(providers) { value in
              Text(value.displayName).tag(value.id)
                .disabled(!value.policy.runnable)
            }
          }
          .labelsHidden()
          .frame(width: 180)
        }
        if let selectedProvider {
          GridRow {
            Text("Policy").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
              Text(selectedProvider.policy.runnable
                ? "Supported"
                : "Not runnable — \(selectedProvider.policy.authorization)")
              ForEach(selectedProvider.policy.caveats, id: \.message) { caveat in
                Text("\(caveat.kind.capitalized): \(caveat.message)")
              }
            }
            .font(.caption)
            .foregroundStyle(selectedProvider.policy.runnable ? Color.secondary : Color.orange)
          }
          if selectedProvider.implementation.kind == "generic-pi-api" {
            GridRow {
              Text("API Key").foregroundStyle(.secondary)
              SecureField(selectedProvider.credentialOptions.first?.label ?? "API key", text: $apiKey)
                .textFieldStyle(.roundedBorder)
                .frame(width: 260)
            }
          }
        }
      }

      HStack {
        Spacer()
        Button("Cancel") {
          isPresented = false
        }
        .keyboardShortcut(.cancelAction)
        Button {
          Task { await save() }
        } label: {
          if isSaving {
            ProgressView()
              .scaleEffect(0.65)
              .frame(width: 14, height: 14)
          } else {
            Text("Create")
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(
          trimmedName.isEmpty || isSaving || selectedProvider?.policy.runnable != true
            || (selectedProvider?.implementation.kind == "generic-pi-api"
              && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        )
      }
    }
    .padding(20)
    .frame(width: 420)
    .onAppear {
      if !providers.contains(where: { $0.id == provider && $0.policy.runnable }),
         let first = providers.first(where: { $0.policy.runnable }) {
        provider = first.id
      }
    }
  }

  @MainActor
  private func save() async {
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }
    do {
      let secret = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
      try await onCreate(trimmedName, provider, trimmedId, secret.isEmpty ? nil : secret)
      apiKey = ""
      isPresented = false
    } catch {
      errorMessage = error.localizedDescription
    }
  }

}

private struct ProviderAccountImportSheet: View {
  @Binding var isPresented: Bool
  let profiles: [Profile]
  let onImport: (String, String?, String?, Bool) async throws -> Void

  @State private var sourceProfileName: String
  @State private var accountId = ""
  @State private var accountName = ""
  @State private var clearLegacyCredentials = false
  @State private var isSaving = false
  @State private var errorMessage: String?

  init(
    isPresented: Binding<Bool>,
    profiles: [Profile],
    onImport: @escaping (String, String?, String?, Bool) async throws -> Void
  ) {
    self._isPresented = isPresented
    self.profiles = profiles
    self.onImport = onImport
    self._sourceProfileName = State(initialValue: profiles.first?.name ?? "")
  }

  private var trimmedAccountId: String? {
    let value = accountId.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  private var trimmedAccountName: String? {
    let value = accountName.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Import Provider Credentials")
        .font(.headline)

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }

      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
        GridRow {
          Text("Source")
            .foregroundStyle(.secondary)
          Picker("", selection: $sourceProfileName) {
            ForEach(profiles) { profile in
              Text(profile.name).tag(profile.name)
            }
          }
          .labelsHidden()
          .frame(width: 260)
        }
        GridRow {
          Text("Account ID")
            .foregroundStyle(.secondary)
          TextField("team-openai", text: $accountId)
            .textFieldStyle(.roundedBorder)
            .font(.system(.body, design: .monospaced))
            .frame(width: 260)
        }
        GridRow {
          Text("Account Name")
            .foregroundStyle(.secondary)
          TextField("Team OpenAI", text: $accountName)
            .textFieldStyle(.roundedBorder)
            .frame(width: 260)
        }
      }

      Toggle("Clear legacy profile credentials", isOn: $clearLegacyCredentials)

      HStack {
        Spacer()
        Button("Cancel") {
          isPresented = false
        }
        .keyboardShortcut(.cancelAction)
        Button {
          Task { await save() }
        } label: {
          if isSaving {
            ProgressView()
              .scaleEffect(0.65)
              .frame(width: 14, height: 14)
          } else {
            Text("Import")
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(sourceProfileName.isEmpty || isSaving)
      }
    }
    .padding(20)
    .frame(width: 430)
  }

  @MainActor
  private func save() async {
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }
    do {
      try await onImport(
        sourceProfileName,
        trimmedAccountId,
        trimmedAccountName,
        clearLegacyCredentials
      )
      isPresented = false
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
