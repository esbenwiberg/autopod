import Foundation
import AutopodClient
import AutopodUI

public protocol PodsitterAPIClient: Sendable {
  func getPodsitterStatus() async throws -> PodsitterStatusResponse
  func configurePodsitter(
    _ configuration: PodsitterConfigurationRequest
  ) async throws -> PodsitterConfigurationResponse
  func enablePodsitter(authorizedUntil: String?) async throws -> PodsitterConfigurationResponse
  func disablePodsitter() async throws -> PodsitterConfigurationResponse
  func checkPodsitter() async throws -> PodsitterCheckResponse
  func probePodsitterProvider() async throws -> PodsitterProbeResponse
  func listPodsitterDecisions(
    podId: String?,
    limit: Int,
    offset: Int
  ) async throws -> PodsitterDecisionListResponse
  func listProviderAccounts(provider: String?) async throws -> [PublicProviderAccountResponse]
  func fetchModelProviderCatalog() async throws -> ProviderCatalogResponse
}

extension DaemonAPI: PodsitterAPIClient {}

public enum PodsitterActivationMode: String, CaseIterable, Sendable {
  case always
  case recurring
}

@Observable
@MainActor
public final class PodsitterStore {
  public static let fullAuthorityWarning =
    "Full authority includes approvals, waivers, retries, recovery, force approval, "
    + "validation skipping, and force completion."
  public static let killSwitchConfirmation =
    "This immediately disables daemon Podsitter and invalidates in-flight action authority. "
    + "Normal pods keep running."

  public private(set) var status: PodsitterStatusResponse?
  public private(set) var accounts: [PublicProviderAccountResponse] = []
  public private(set) var catalog: ProviderCatalogResponse?
  public private(set) var decisions: [PodsitterDecisionRecordResponse] = []
  public private(set) var isLoading = false
  public private(set) var isSaving = false
  public private(set) var isChecking = false
  public private(set) var isProbing = false
  public var error: String?

  public var selectedAccountId = ""
  public var selectedRuntime: PodsitterRuntime = .codex
  public var selectedModel = ""
  public var activationMode: PodsitterActivationMode = .always
  public var cronExpression = "0 20 * * *"
  public var durationMinutes = 720
  public var timeZone = TimeZone.current.identifier
  public var hasExpiry = false
  public var expiry = Date().addingTimeInterval(86_400)
  public var selectedProfiles: Set<String> = []
  public var allProfiles = true

  private let api: any PodsitterAPIClient
  private let isoFormatter = ISO8601DateFormatter()

  public init(api: any PodsitterAPIClient) {
    self.api = api
    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  }

  public var isConfigured: Bool { status?.configuration != nil }
  public var isEnabled: Bool { status?.configuration?.enabled == true }
  public var isCurrentlyActive: Bool { status?.activation?.active == true }
  public var isProviderAvailable: Bool { status?.provider?.status == .available }
  public var deferredCount: Int { status?.queueCount ?? 0 }

  public var stateLabel: String {
    guard let configuration = status?.configuration else { return "Not configured" }
    guard configuration.enabled else { return "Configured · disabled" }
    if status?.provider?.status != nil, !isProviderAvailable {
      return "Enabled · provider limited"
    }
    if !isCurrentlyActive {
      return status?.activation?.reason == "expired"
        ? "Enabled · authorization expired"
        : "Enabled · inactive window"
    }
    if deferredCount > 0 { return "Enabled · active · draining \(deferredCount)" }
    return "Enabled · active"
  }

  public var providerLabel: String {
    guard let provider = status?.provider else { return "Provider not checked" }
    let state = switch provider.status {
    case .available: "available"
    case .rateLimited: "rate limited"
    case .quotaExhausted: "quota exhausted"
    case .authFailed: "authentication failed"
    case .unavailable: "unavailable"
    case let .unknown(value): value.replacingOccurrences(of: "_", with: " ")
    }
    if provider.status == .available, let recoveredAt = provider.recoveredAt {
      return "\(state) · recovered \(Self.shortDate(recoveredAt))"
    }
    if let next = provider.retryAt ?? provider.resetAt {
      return "\(state) · next probe \(Self.shortDate(next))"
    }
    return state
  }

  public var lastActionLabel: String {
    guard let record = decisions.first else { return "No decisions yet" }
    let action = record.decision?.action.replacingOccurrences(of: "_", with: " ") ?? record.outcome
    return "\(action) on \(record.podId)"
  }

  public var compatibleRuntimes: [PodsitterRuntime] {
    guard let account = selectedAccount else { return [] }
    return Self.compatibleRuntimes(provider: account.provider)
  }

  public var compatibleModels: [RuntimeModelOption] {
    guard let account = selectedAccount,
          compatibleRuntimes.contains(selectedRuntime),
          let runtime = RuntimeType(rawValue: selectedRuntime.rawValue)
    else { return [] }
    if runtime == .pi {
      guard let provider = catalog?.provider(id: account.provider),
            provider.implementation.kind == "generic-pi-api",
            provider.policy.runnable,
            provider.policy.authorization == "supported"
      else { return [] }
    }
    return RuntimeModelOptions.options(
      for: runtime,
      role: .defaultModel,
      currentValue: selectedModel,
      catalog: catalog,
      providerId: account.provider
    )
  }

  public var selectedAccount: PublicProviderAccountResponse? {
    accounts.first { $0.id == selectedAccountId }
  }

  public var targetIsValid: Bool {
    guard let account = selectedAccount, account.hasCredentials else { return false }
    return compatibleRuntimes.contains(selectedRuntime)
      && !selectedModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  public var activationIsValid: Bool {
    if hasExpiry, expiry <= Date() { return false }
    guard activationMode == .recurring else { return true }
    return Self.isValidFiveFieldCron(cronExpression)
      && durationMinutes > 0
      && TimeZone(identifier: timeZone) != nil
  }

  public var canSave: Bool { targetIsValid && activationIsValid && !isSaving }
  public var canEnable: Bool { canSave }
  public var needsProviderAuthentication: Bool {
    selectedAccount.map { !$0.hasCredentials } ?? false
  }

  public func load() async {
    isLoading = true
    defer { isLoading = false }
    do {
      async let statusLoad = api.getPodsitterStatus()
      async let accountsLoad = api.listProviderAccounts(provider: nil)
      async let catalogLoad = api.fetchModelProviderCatalog()
      async let historyLoad = api.listPodsitterDecisions(podId: nil, limit: 20, offset: 0)
      let loaded = try await (statusLoad, accountsLoad, catalogLoad, historyLoad)
      status = loaded.0
      accounts = loaded.1
      catalog = loaded.2
      decisions = loaded.3.items
      applyConfiguration(loaded.0.configuration)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func refreshStatusAndHistory() async {
    do {
      async let statusLoad = api.getPodsitterStatus()
      async let historyLoad = api.listPodsitterDecisions(podId: nil, limit: 20, offset: 0)
      let loaded = try await (statusLoad, historyLoad)
      status = loaded.0
      decisions = loaded.1.items
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func save(enable: Bool = false) async {
    guard canSave else {
      error = "Choose an authenticated compatible account, runtime, model, and valid authorization."
      return
    }
    isSaving = true
    defer { isSaving = false }
    do {
      let wasEnabled = isEnabled
      let configuration = try await api.configurePodsitter(
        configurationRequest(enabled: wasEnabled)
      )
      status = statusReplacingConfiguration(configuration)
      if enable && !wasEnabled {
        let enabled = try await api.enablePodsitter(authorizedUntil: expiryString)
        status = statusReplacingConfiguration(enabled)
      }
      await refreshStatusAndHistory()
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func disableNow() async {
    isSaving = true
    defer { isSaving = false }
    do {
      let disabled = try await api.disablePodsitter()
      status = statusReplacingConfiguration(disabled, forcedActive: false)
      error = nil
      await refreshStatusAndHistory()
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func checkNow() async {
    isChecking = true
    defer { isChecking = false }
    do {
      _ = try await api.checkPodsitter()
      await refreshStatusAndHistory()
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func probeNow() async {
    isProbing = true
    defer { isProbing = false }
    do {
      _ = try await api.probePodsitterProvider()
      await refreshStatusAndHistory()
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func selectAccount(_ id: String) {
    selectedAccountId = id
    if !compatibleRuntimes.contains(selectedRuntime) {
      selectedRuntime = compatibleRuntimes.first ?? .pi
    }
    if !compatibleModels.contains(where: { $0.id == selectedModel }) {
      selectedModel = compatibleModels.first?.id ?? ""
    }
  }

  public func selectRuntime(_ runtime: PodsitterRuntime) {
    selectedRuntime = runtime
  }

  public static func compatibleRuntimes(provider: String) -> [PodsitterRuntime] {
    if ["anthropic", "max"].contains(provider) { return [.claude] }
    if ["openai", "openrouter"].contains(provider) { return [.codex] }
    if provider == "foundry" { return [.claude, .codex] }
    if provider == "copilot" { return [.copilot] }
    if provider == "pi" { return [.pi] }
    return []
  }

  public static func isValidFiveFieldCron(_ expression: String) -> Bool {
    let fields = expression.split(whereSeparator: \.isWhitespace).map(String.init)
    guard fields.count == 5 else { return false }
    let ranges = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
    let monthNames = [
      "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
      "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
    ]
    let weekdayNames = [
      "SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6,
    ]

    func value(_ token: Substring, field: Int) -> Int? {
      if let number = Int(token) { return number }
      let name = token.uppercased()
      if field == 3 { return monthNames[name] }
      if field == 4 { return weekdayNames[name] }
      return nil
    }

    func atomIsValid(_ atom: Substring, field: Int) -> Bool {
      let stepParts = atom.split(separator: "/", omittingEmptySubsequences: false)
      guard stepParts.count <= 2 else { return false }
      if stepParts.count == 2 {
        guard let step = Int(stepParts[1]), step > 0 else { return false }
      }
      let base = stepParts[0]
      if base == "*" { return true }
      let rangeParts = base.split(separator: "-", omittingEmptySubsequences: false)
      guard rangeParts.count <= 2,
            let start = value(rangeParts[0], field: field)
      else { return false }
      let bounds = ranges[field]
      guard bounds.0...bounds.1 ~= start else { return false }
      if rangeParts.count == 2 {
        guard let end = value(rangeParts[1], field: field),
              bounds.0...bounds.1 ~= end,
              start <= end
        else { return false }
      }
      return true
    }

    return fields.enumerated().allSatisfy { field, value in
      let atoms = value.split(separator: ",", omittingEmptySubsequences: false)
      return !atoms.isEmpty && atoms.allSatisfy { atomIsValid($0, field: field) }
    }
  }

  private var expiryString: String? {
    hasExpiry ? isoFormatter.string(from: expiry) : nil
  }

  private func configurationRequest(enabled: Bool) -> PodsitterConfigurationRequest {
    let activation: PodsitterActivationResponse = activationMode == .always
      ? .always
      : .recurring(
        cronExpression: cronExpression.trimmingCharacters(in: .whitespacesAndNewlines),
        durationMinutes: durationMinutes,
        timeZone: timeZone
      )
    return PodsitterConfigurationRequest(
      enabled: enabled,
      activation: activation,
      authorizedUntil: expiryString,
      profileScope: allProfiles ? nil : selectedProfiles.sorted(),
      decisionTarget: PodsitterDecisionTargetResponse(
        providerAccountId: selectedAccountId,
        runtime: selectedRuntime,
        model: selectedModel.trimmingCharacters(in: .whitespacesAndNewlines)
      ),
      budgets: status?.configuration?.budgets
        ?? PodsitterBudgetsResponse(maxDecisionsPerWindow: 20, maxActionsPerWindow: 10)
    )
  }

  private func applyConfiguration(_ configuration: PodsitterConfigurationResponse?) {
    guard let configuration else { return }
    if let target = configuration.decisionTarget {
      selectedAccountId = target.providerAccountId
      selectedRuntime = target.runtime
      selectedModel = target.model
    }
    switch configuration.activation {
    case .always:
      activationMode = .always
    case let .recurring(cron, duration, zone):
      activationMode = .recurring
      cronExpression = cron
      durationMinutes = duration
      timeZone = zone
    }
    if let value = configuration.authorizedUntil, let date = Self.parseDate(value) {
      hasExpiry = true
      expiry = date
    } else {
      hasExpiry = false
    }
    allProfiles = configuration.profileScope == nil
    selectedProfiles = Set(configuration.profileScope ?? [])
  }

  private func statusReplacingConfiguration(
    _ configuration: PodsitterConfigurationResponse,
    forcedActive: Bool? = nil
  ) -> PodsitterStatusResponse {
    var activation = status?.activation
    if let forcedActive {
      activation?.active = forcedActive
      if !forcedActive { activation?.reason = "disabled" }
    }
    return PodsitterStatusResponse(
      configuration: configuration,
      activation: activation,
      provider: status?.provider,
      queueCount: status?.queueCount ?? 0
    )
  }

  private static func parseDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }

  private static func shortDate(_ value: String) -> String {
    guard let date = parseDate(value) else { return value }
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
