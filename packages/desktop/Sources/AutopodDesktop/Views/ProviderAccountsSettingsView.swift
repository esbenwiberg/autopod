import SwiftUI
import AutopodClient
import AutopodUI

struct ProviderAccountsSettingsView: View {
  let api: DaemonAPI?
  let profiles: [Profile]
  let onProfilesChanged: (() async -> Void)?

  @State private var accounts: [PublicProviderAccountResponse] = []
  @State private var isLoading = false
  @State private var errorMessage: String?
  @State private var showCreateSheet = false
  @State private var showImportSheet = false
  @State private var inFlightAction: String?
  @State private var deleteTarget: PublicProviderAccountResponse?
  @State private var expandedFailoverAccounts: Set<String> = []
  @State private var failoverDrafts: [String: ProviderFailoverPolicyResponse] = [:]
  @State private var failoverSaveErrors: [String: String] = [:]

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
      ProviderAccountCreateSheet(isPresented: $showCreateSheet) { name, provider, id in
        try await createAccount(name: name, provider: provider, id: id)
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
      .disabled(api == nil)
      .help("Create provider account")
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
      .filter { $0.modelProvider.rawValue == account.provider && $0.providerAccountId != account.id }
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

        Button {
          toggleFailoverEditor(account)
        } label: {
          Image(systemName: "arrow.triangle.branch")
        }
        .buttonStyle(.borderless)
        .disabled(isAccountBusy(account.id))
        .help("Edit default failover chain")

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

      metadataRow(account)

      if expandedFailoverAccounts.contains(account.id) {
        Divider()
        defaultFailoverEditor(account)
      }
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
      let loaded = try await api.listProviderAccounts()
      accounts = loaded
      for account in loaded where failoverDrafts[account.id] == nil {
        failoverDrafts[account.id] = account.failoverPolicy ?? ProviderFailoverPolicyResponse(targets: [])
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func toggleFailoverEditor(_ account: PublicProviderAccountResponse) {
    if expandedFailoverAccounts.contains(account.id) {
      expandedFailoverAccounts.remove(account.id)
    } else {
      failoverDrafts[account.id] =
        failoverDrafts[account.id] ?? account.failoverPolicy ?? ProviderFailoverPolicyResponse(targets: [])
      expandedFailoverAccounts.insert(account.id)
    }
  }

  private func failoverBinding(for account: PublicProviderAccountResponse)
    -> Binding<ProviderFailoverPolicyResponse>
  {
    Binding(
      get: {
        failoverDrafts[account.id]
          ?? account.failoverPolicy
          ?? ProviderFailoverPolicyResponse(targets: [])
      },
      set: { failoverDrafts[account.id] = $0 }
    )
  }

  @ViewBuilder
  private func defaultFailoverEditor(_ account: PublicProviderAccountResponse) -> some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text("Default failover chain")
            .font(.callout.weight(.semibold))
          Text("Used unless a profile defines its own policy.")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button("Revert") {
          failoverDrafts[account.id] =
            account.failoverPolicy ?? ProviderFailoverPolicyResponse(targets: [])
          failoverSaveErrors[account.id] = nil
        }
        .buttonStyle(.borderless)
        .disabled(isAccountBusy(account.id))

        Button {
          Task { await saveFailoverPolicy(account) }
        } label: {
          if inFlightAction == "failover:\(account.id)" {
            ProgressView().scaleEffect(0.6)
          } else {
            Text("Save")
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(isAccountBusy(account.id))
      }

      ProviderFailoverEditor(
        policy: failoverBinding(for: account),
        accounts: accounts,
        excludedAccountId: account.id,
        isLoading: isLoading,
        loadError: errorMessage
      )

      if let message = failoverSaveErrors[account.id] {
        HStack(alignment: .top, spacing: 5) {
          Image(systemName: "exclamationmark.triangle.fill")
          Text(message).fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption2)
        .foregroundStyle(.red)
      }
    }
  }

  @MainActor
  private func saveFailoverPolicy(_ account: PublicProviderAccountResponse) async {
    guard let api else { return }
    let draft = failoverDrafts[account.id] ?? ProviderFailoverPolicyResponse(targets: [])
    inFlightAction = "failover:\(account.id)"
    failoverSaveErrors[account.id] = nil
    defer { inFlightAction = nil }
    do {
      let value: Any = draft.targets.isEmpty ? NSNull() : draft.dictionary
      let updated = try await api.updateProviderAccount(account.id, fields: ["failoverPolicy": value])
      if let index = accounts.firstIndex(where: { $0.id == account.id }) {
        accounts[index] = updated
      }
      failoverDrafts[account.id] =
        updated.failoverPolicy ?? ProviderFailoverPolicyResponse(targets: [])
    } catch {
      // Keep the draft untouched so the administrator can correct and retry.
      failoverSaveErrors[account.id] = error.localizedDescription
    }
  }

  @MainActor
  private func createAccount(name: String, provider: String, id: String?) async throws {
    guard let api else { throw DaemonError.networkError("Not connected to daemon") }
    _ = try await api.createProviderAccount(name: name, provider: provider, id: id)
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
    if account.provider == "pi" {
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

private struct ProviderAccountCreateSheet: View {
  @Binding var isPresented: Bool
  let onCreate: (String, String, String?) async throws -> Void

  @State private var name = ""
  @State private var accountId = ""
  @State private var provider = "openai"
  @State private var isSaving = false
  @State private var errorMessage: String?

  private let providers = ["anthropic", "max", "openai", "foundry", "copilot", "openrouter", "pi"]

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
            ForEach(providers, id: \.self) { value in
              Text(providerLabel(value)).tag(value)
            }
          }
          .labelsHidden()
          .frame(width: 180)
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
        .disabled(trimmedName.isEmpty || isSaving)
      }
    }
    .padding(20)
    .frame(width: 420)
  }

  @MainActor
  private func save() async {
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }
    do {
      try await onCreate(trimmedName, provider, trimmedId)
      isPresented = false
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func providerLabel(_ provider: String) -> String {
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
