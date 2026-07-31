import Foundation
import XCTest
@testable import AutopodClient
@testable import AutopodDesktop

private enum PodsitterMockError: LocalizedError {
  case offline
  var errorDescription: String? { "Podsitter API unavailable" }
}

private actor MockPodsitterAPI: PodsitterAPIClient {
  var calls: [String] = []
  var failStatus = false
  var status: PodsitterStatusResponse
  let configuration: PodsitterConfigurationResponse
  let accounts: [PublicProviderAccountResponse]
  let catalog: ProviderCatalogResponse
  let history: PodsitterDecisionListResponse

  init(providerStatus: String = "available", active: Bool = true, enabled: Bool = true) {
    let decoder = JSONDecoder()
    configuration = try! decoder.decode(
      PodsitterConfigurationResponse.self,
      from: Data(Self.configurationJSON(enabled: enabled).utf8)
    )
    status = try! decoder.decode(
      PodsitterStatusResponse.self,
      from: Data(Self.statusJSON(providerStatus: providerStatus, active: active, enabled: enabled).utf8)
    )
    accounts = try! decoder.decode(
      [PublicProviderAccountResponse].self,
      from: Data(Self.accountsJSON.utf8)
    )
    catalog = try! decoder.decode(ProviderCatalogResponse.self, from: Data(Self.catalogJSON.utf8))
    history = try! decoder.decode(
      PodsitterDecisionListResponse.self,
      from: Data(Self.historyJSON.utf8)
    )
  }

  func getPodsitterStatus() async throws -> PodsitterStatusResponse {
    calls.append("status")
    if failStatus { throw PodsitterMockError.offline }
    return status
  }

  func configurePodsitter(
    _ configuration: PodsitterConfigurationRequest
  ) async throws -> PodsitterConfigurationResponse {
    calls.append("configure:\(configuration.activation)")
    return self.configuration
  }

  func enablePodsitter(authorizedUntil: String?) async throws -> PodsitterConfigurationResponse {
    calls.append("enable")
    return configuration
  }

  func disablePodsitter() async throws -> PodsitterConfigurationResponse {
    calls.append("disable")
    var disabled = configuration
    disabled.enabled = false
    status.configuration = disabled
    status.activation?.active = false
    status.activation?.reason = "disabled"
    return disabled
  }

  func checkPodsitter() async throws -> PodsitterCheckResponse {
    calls.append("check")
    return PodsitterCheckResponse(queued: 2, processed: 1)
  }

  func probePodsitterProvider() async throws -> PodsitterProbeResponse {
    calls.append("probe")
    return PodsitterProbeResponse(recovered: true)
  }

  func listPodsitterDecisions(
    podId: String?,
    limit: Int,
    offset: Int
  ) async throws -> PodsitterDecisionListResponse {
    calls.append("history")
    return history
  }

  func listProviderAccounts(provider: String?) async throws -> [PublicProviderAccountResponse] {
    calls.append("accounts")
    return accounts
  }

  func fetchModelProviderCatalog() async throws -> ProviderCatalogResponse {
    calls.append("catalog")
    return catalog
  }

  func setFailStatus(_ value: Bool) { failStatus = value }
  func recordedCalls() -> [String] { calls }

  static func configurationJSON(enabled: Bool) -> String {
    """
    {"enabled":\(enabled),"activation":{"mode":"recurring","cronExpression":"0 20 * * *",
    "durationMinutes":720,"timeZone":"Europe/Copenhagen"},"authorizedUntil":null,
    "generation":1,"profileScope":["autopod-self"],
    "decisionTarget":{"providerAccountId":"openai-sitter","runtime":"codex","model":"gpt-5"},
    "budgets":{"maxDecisionsPerWindow":20,"maxActionsPerWindow":10},
    "createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"}
    """
  }

  static func statusJSON(providerStatus: String, active: Bool, enabled: Bool) -> String {
    """
    {"configuration":\(configurationJSON(enabled: enabled)),
    "activation":{"active":\(active),"windowId":"window","windowStartedAt":"2026-07-31T20:00:00Z",
    "windowEndsAt":"2026-08-01T08:00:00Z","reason":"\(active ? "active" : "outside_window")"},
    "provider":{"providerAccountId":"openai-sitter","status":"\(providerStatus)",
    "consecutiveFailures":1,"retryAt":"2026-08-01T03:15:00Z","resetAt":null,
    "sanitizedReason":"subscription limit","recoveredAt":"2026-07-31T02:00:00Z",
    "updatedAt":"2026-07-31T03:00:00Z"},"queueCount":3}
    """
  }

  static let accountsJSON = """
  [
    {"id":"openai-sitter","name":"Dedicated Sitter","provider":"openai",
      "hasCredentials":true,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},
    {"id":"anthropic-locked","name":"Needs login","provider":"anthropic",
      "hasCredentials":false,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}
  ]
  """

  static let catalogJSON = """
  {"manifestVersion":1,"piCompatibility":{"packageName":"pi","packageVersion":"1","source":"pinned"},
  "providers":[{"id":"openai","displayName":"OpenAI","description":"OpenAI","icon":null,
    "implementation":{"kind":"built-in","adapterId":null,"piProviderId":null},
    "credentialOptions":[],"modelIds":["gpt-5"],"requiredHosts":[],
    "policy":{"lifecycle":"stable","authorization":"supported","runnable":true,"caveats":[]}}],
  "models":[{"id":"gpt-5","providerId":"openai","displayName":"GPT-5","lifecycle":"stable"}]}
  """

  static let historyJSON = """
  {"items":[{"id":"decision","podId":"industrial-manatee",
    "decision":{"action":"approve_fact_waiver","reason":"Fact is stale",
      "evidenceRefs":["fact:fact-x"],"confidence":"high","remainingRisk":"Review after merge",
      "stopCondition":"One waiver only"},"outcome":"completed","failureCode":null,
    "createdAt":"2026-07-31T02:00:00Z","completedAt":"2026-07-31T02:01:00Z",
    "executedAt":"2026-07-31T02:01:00Z"}],"total":1}
  """
}

@MainActor
final class PodsitterStoreTests: XCTestCase {
  func testActivationAndFullAuthorityValidation() async {
    let api = MockPodsitterAPI()
    let store = PodsitterStore(api: api)
    await store.load()

    XCTAssertTrue(PodsitterStore.fullAuthorityWarning.contains("approvals"))
    XCTAssertTrue(PodsitterStore.fullAuthorityWarning.contains("waivers"))
    XCTAssertTrue(PodsitterStore.fullAuthorityWarning.contains("retries"))
    XCTAssertTrue(PodsitterStore.fullAuthorityWarning.contains("recovery"))
    XCTAssertTrue(PodsitterStore.fullAuthorityWarning.contains("force approval"))
    XCTAssertTrue(PodsitterStore.fullAuthorityWarning.contains("validation skipping"))
    XCTAssertTrue(PodsitterStore.fullAuthorityWarning.contains("force completion"))

    store.activationMode = .recurring
    store.cronExpression = "x x x x x"
    XCTAssertFalse(store.activationIsValid)
    store.cronExpression = "0 20 * * *"
    store.durationMinutes = 0
    XCTAssertFalse(store.activationIsValid)
    XCTAssertFalse(store.canEnable)
    store.durationMinutes = 720
    store.timeZone = "Not/A_Timezone"
    XCTAssertFalse(store.activationIsValid)
    store.timeZone = "Europe/Copenhagen"
    XCTAssertTrue(store.activationIsValid)
    store.cronExpression = "*/15 20-23 * JAN,MAR MON-FRI"
    XCTAssertTrue(store.activationIsValid)
    XCTAssertTrue(store.canEnable)

    store.selectedRuntime = .claude
    XCTAssertFalse(store.targetIsValid, "OpenAI account must not run the Claude runtime")
  }

  func testProviderRuntimeCompatibilityMatchesDaemonAccounts() {
    XCTAssertEqual(PodsitterStore.compatibleRuntimes(provider: "anthropic"), [.claude])
    XCTAssertEqual(PodsitterStore.compatibleRuntimes(provider: "max"), [.claude])
    XCTAssertEqual(PodsitterStore.compatibleRuntimes(provider: "openai"), [.codex])
    XCTAssertEqual(PodsitterStore.compatibleRuntimes(provider: "openrouter"), [.codex])
    XCTAssertEqual(PodsitterStore.compatibleRuntimes(provider: "foundry"), [.claude, .codex])
    XCTAssertEqual(PodsitterStore.compatibleRuntimes(provider: "copilot"), [.copilot])
    XCTAssertEqual(PodsitterStore.compatibleRuntimes(provider: "pi"), [.pi])
    XCTAssertTrue(PodsitterStore.compatibleRuntimes(provider: "unknown").isEmpty)
  }

  func testOperationalStatesRemainDistinct() async {
    let limitedAPI = MockPodsitterAPI(providerStatus: "quota_exhausted", active: false)
    let limited = PodsitterStore(api: limitedAPI)
    await limited.load()
    XCTAssertTrue(limited.isEnabled)
    XCTAssertFalse(limited.isCurrentlyActive)
    XCTAssertFalse(limited.isProviderAvailable)
    XCTAssertEqual(limited.deferredCount, 3)
    XCTAssertEqual(limited.stateLabel, "Enabled · provider limited")
    XCTAssertTrue(limited.providerLabel.contains("quota exhausted"))
    XCTAssertTrue(limited.providerLabel.contains("next probe"))

    let recoveredAPI = MockPodsitterAPI(providerStatus: "available", active: true)
    let recovered = PodsitterStore(api: recoveredAPI)
    await recovered.load()
    XCTAssertTrue(recovered.isCurrentlyActive)
    XCTAssertTrue(recovered.isProviderAvailable)
    XCTAssertTrue(recovered.stateLabel.contains("draining 3"))
    XCTAssertTrue(recovered.providerLabel.contains("recovered"))

    await recoveredAPI.setFailStatus(true)
    await recovered.refreshStatusAndHistory()
    XCTAssertTrue(recovered.isEnabled, "Refresh failure must retain last known status")
    XCTAssertNotNil(recovered.error)
  }

  func testDisableNowCallsDaemon() async {
    let api = MockPodsitterAPI()
    let store = PodsitterStore(api: api)
    await store.load()
    await store.disableNow()

    let calls = await api.recordedCalls()
    XCTAssertTrue(calls.contains("disable"))
    XCTAssertFalse(store.isEnabled)
    XCTAssertFalse(store.isCurrentlyActive)
    XCTAssertTrue(PodsitterStore.killSwitchConfirmation.contains("in-flight action authority"))
    XCTAssertTrue(PodsitterStore.killSwitchConfirmation.contains("Normal pods keep running"))
  }

  func testConfigureEnableCheckProbeAndHistory() async {
    let api = MockPodsitterAPI(enabled: false)
    let store = PodsitterStore(api: api)
    await store.load()
    await store.save(enable: true)
    await store.checkNow()
    await store.probeNow()

    let calls = await api.recordedCalls()
    XCTAssertTrue(calls.contains(where: { $0.hasPrefix("configure:") }))
    XCTAssertTrue(calls.contains("enable"))
    XCTAssertTrue(calls.contains("check"))
    XCTAssertTrue(calls.contains("probe"))
    XCTAssertEqual(store.decisions.first?.podId, "industrial-manatee")
    XCTAssertEqual(store.lastActionLabel, "approve fact waiver on industrial-manatee")
  }
}
