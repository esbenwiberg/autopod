import AutopodClient
import Foundation
import SwiftUI

func validationPageScreenshot(
  _ page: PageDetail,
  proofOfWorkScreenshots: [ScreenshotRef]?
) -> ScreenshotRef? {
  if let screenshot = page.screenshot {
    return screenshot
  }
  return proofOfWorkScreenshots?.first { ref in
    ref.source == .smoke && ref.label == page.path
  }
}

public func validationHistoryShouldRefreshAfterAdvisory(
  selectedHistory: StoredValidationResponse?,
  progress: ValidationProgress?
) -> Bool {
  guard let selectedHistory else { return false }
  guard selectedHistory.result.advisoryBrowserQa == nil else { return false }
  guard progress?.advisoryDetail != nil else { return false }
  return progress?.advisory.status != .running
}

/// Validation tab — shows live per-phase progress chips + a detail panel for the selected phase.
///
/// Data priority:
///   1. `progress` (live, streamed from WebSocket events)
///   2. `checks`   (full result, from REST refresh after completion)
///   3. Neither → empty state with all chips in "not started"
public struct ValidationTab: View {
  public let pod: Pod
  public let checks: ValidationChecks?
  public var actions: PodActions
  public var loadValidationHistory: ((String) async throws -> [StoredValidationResponse])?

  @Environment(\.daemonBaseURL) private var daemonBaseURL

  @State private var selectedPhase: ValidationPhase? = nil
  @State private var selectedHistoryKey: String = "current"
  @State private var validationHistory: [StoredValidationResponse] = []
  @State private var isLoadingHistory = false
  @State private var historyError: String?
  @State private var expandedBuildOutput = false
  @State private var expandedSetupOutput = false
  @State private var expandedTestOutput = false
  @State private var expandedLintOutput = false
  @State private var expandedSastOutput = false
  @State private var isOpeningApp = false
  @State private var isInterrupting = false
  @State private var isSkippingValidation = false
  @State private var isForceApproving = false
  @State private var isUpdatingFromBase = false
  @State private var updateFromBaseMessage: String?
  @State private var showForceApprovePopover = false
  @State private var forceApproveReason: String = ""
  @State private var factWaiverPopoverFactId: String? = nil
  @State private var factWaiverReason: String = ""
  @State private var approvingFactWaiverIds: Set<String> = []
  @State private var expandedFactOutputIds: Set<String> = []
  @State private var overridePopoverFindingId: String? = nil
  @State private var overrideAction: String = "dismiss"
  @State private var overrideReason: String = ""
  @State private var overrideGuidance: String = ""
  @State private var dismissedFindingIds: Set<String> = []
  @State private var isPreSubmitExpanded = false
  // Lightbox state — one instance at the tab level; thumbnails write into these
  @State private var lightboxRefs: [ScreenshotRef] = []
  @State private var lightboxIndex: Int = 0
  @State private var isLightboxPresented: Bool = false

  public init(
    pod: Pod,
    checks: ValidationChecks? = nil,
    actions: PodActions = .preview,
    loadValidationHistory: ((String) async throws -> [StoredValidationResponse])? = nil
  ) {
    self.pod = pod
    self.checks = checks ?? pod.validationChecks
    self.actions = actions
    self.loadValidationHistory = loadValidationHistory
  }

  // MARK: - Derived state

  private var liveProgress: ValidationProgress? {
    selectedHistory == nil ? pod.validationProgress : nil
  }

  private var progress: ValidationProgress? {
    guard let liveProgress else { return nil }
    if pod.status == .validating || liveProgress.hasRunningPhase || liveProgress.advisoryDetail != nil {
      return liveProgress
    }
    return nil
  }

  private var displayedChecks: ValidationChecks? {
    selectedHistory.map { validationChecks(from: $0.result) } ?? checks
  }

  private var displayedAdvisoryQa: AdvisoryQaDetail? {
    displayedChecks?.advisoryQa ?? liveProgress?.advisoryDetail
  }

  private var selectedHistory: StoredValidationResponse? {
    guard let attempt = Int(selectedHistoryKey) else { return nil }
    return validationHistory.first { $0.attempt == attempt }
  }

  private var sortedValidationHistory: [StoredValidationResponse] {
    validationHistory.sorted { lhs, rhs in
      if lhs.attempt != rhs.attempt { return lhs.attempt > rhs.attempt }
      return lhs.createdAt > rhs.createdAt
    }
  }

  private func fetchValidationHistory() async {
    guard let loadValidationHistory else { return }
    isLoadingHistory = true
    historyError = nil
    do {
      validationHistory = try await loadValidationHistory(pod.id)
      if selectedHistoryKey != "current", selectedHistory == nil {
        selectedHistoryKey = "current"
      }
    } catch {
      validationHistory = []
      historyError = "Could not load validation history: \(error.localizedDescription)"
      selectedHistoryKey = "current"
    }
    isLoadingHistory = false
  }

  private func validationChecks(from response: ValidationResponse) -> ValidationChecks {
    let setupOutput = response.setup?.failureOutput
    let buildOutput = response.smoke.build.status == "fail" && !response.smoke.build.output.isEmpty
      ? response.smoke.build.output
      : nil
    let testOutput: String? = {
      guard let test = response.test, test.status != "pass" else { return nil }
      let combined = [test.stdout, test.stderr].compactMap { $0 }.joined(separator: "\n")
      return combined.isEmpty ? nil : combined
    }()
    let lintOutput = response.lint?.status == "fail" && response.lint?.output.isEmpty == false
      ? response.lint?.output
      : nil
    let sastOutput = response.sast?.status == "fail" && response.sast?.output.isEmpty == false
      ? response.sast?.output
      : nil
    let healthCheck = HealthCheckDetail(
      status: response.smoke.health.status,
      url: response.smoke.health.url,
      responseCode: response.smoke.health.responseCode,
      duration: response.smoke.health.duration,
      responseBody: response.smoke.health.responseBody
    )
    let pages: [PageDetail]? = response.smoke.pages.isEmpty ? nil : response.smoke.pages.map { page in
      PageDetail(
        path: page.path,
        status: page.status,
        consoleErrors: page.consoleErrors,
        assertions: page.assertions.map { assertion in
          AssertionDetail(
            selector: assertion.selector,
            type: assertion.type,
            expected: assertion.expected,
            actual: assertion.actual,
            passed: assertion.passed
          )
        },
        loadTime: page.loadTime,
        screenshot: mapScreenshotRef(page.screenshot)
      )
    }
    let factValidation: Bool? = response.factValidation.flatMap {
      $0.status == "skip" ? nil : ($0.status == "pass")
    }
    let factChecks = response.factValidation?.results.map { fact in
      FactCheckDetail(
        factId: fact.factId,
        proves: fact.proves,
        kind: fact.kind,
        artifactPath: fact.artifactPath,
        command: fact.command,
        passed: fact.passed,
        status: fact.status,
        exitCode: fact.exitCode,
        durationMs: fact.durationMs,
        artifact: fact.artifact,
        attachments: fact.attachments,
        reasoning: fact.reasoning,
        stdout: fact.stdout,
        stderr: fact.stderr
      )
    }
    let requirementsCheck = response.taskReview?.requirementsCheck?.map {
      RequirementCheckDetail(criterion: $0.criterion, met: $0.met, note: $0.note)
    }
    let taskReviewScreenshots: [ScreenshotRef]? = {
      guard let screenshots = response.taskReview?.screenshots, !screenshots.isEmpty else { return nil }
      let refs = screenshots.compactMap { mapScreenshotRef($0) }
      return refs.isEmpty ? nil : refs
    }()
    let advisoryQa: AdvisoryQaDetail? = response.advisoryBrowserQa.map { advisory in
      AdvisoryQaDetail(
        status: advisory.status,
        reasoning: advisory.reasoning,
        model: advisory.model,
        durationMs: advisory.durationMs,
        observations: advisory.observations.map { observation in
          AdvisoryQaObservationDetail(
            id: observation.id,
            scenarioId: observation.scenarioId,
            status: observation.status,
            summary: observation.summary,
            details: observation.details,
            screenshots: observation.screenshots.compactMap { mapScreenshotRef($0) },
            suggestedFacts: observation.suggestedFacts
          )
        },
        screenshots: advisory.screenshots.compactMap { mapScreenshotRef($0) }
      )
    }
    let proofOfWorkScreenshots: [ScreenshotRef]? = {
      let smokeRefs = response.smoke.pages.compactMap { mapScreenshotRef($0.screenshot) }
      let factRefs = (response.factValidation?.results ?? []).flatMap { fact in
        (fact.attachments ?? []).compactMap { attachment in
          mapScreenshotRef(attachment.screenshot)
        }
      }
      let refs = smokeRefs + factRefs
      return refs.isEmpty ? nil : refs
    }()

    return ValidationChecks(
      smoke: response.smoke.status == "pass",
      setup: mapTriState(response.setup?.status),
      build: mapTriState(response.smoke.build.status),
      tests: mapTriState(response.test?.status),
      lint: mapTriState(response.lint?.status),
      sast: mapTriState(response.sast?.status),
      review: mapTriState(response.taskReview?.status),
      setupOutput: setupOutput,
      buildOutput: buildOutput,
      testOutput: testOutput,
      lintOutput: lintOutput,
      sastOutput: sastOutput,
      reviewIssues: response.taskReview?.issues,
      reviewReasoning: response.taskReview?.reasoning,
      reviewSkipReason: response.reviewSkipReason,
      reviewSkipKind: response.reviewSkipKind,
      validationSuite: response.validationSuite,
      healthCheck: healthCheck,
      pages: pages,
      factValidation: factValidation,
      factChecks: factChecks,
      requirementsCheck: requirementsCheck,
      taskReviewScreenshots: taskReviewScreenshots,
      advisoryQa: advisoryQa,
      proofOfWorkScreenshots: proofOfWorkScreenshots
    )
  }

  private func mapScreenshotRef(_ dto: ScreenshotRefResponse?) -> ScreenshotRef? {
    guard let dto, let baseURL = daemonBaseURL else { return nil }
    let source: ScreenshotRef.Source
    switch dto.source {
    case "smoke": source = .smoke
    case "fact": source = .fact
    case "review": source = .review
    case "advisory": source = .advisory
    default: return nil
    }
    guard let url = URL(string: dto.url, relativeTo: baseURL)?.absoluteURL else { return nil }
    return ScreenshotRef(url: url, source: source, label: dto.path)
  }

  private func mapTriState(_ status: String?) -> Bool? {
    switch status {
    case "pass": true
    case "fail": false
    default: nil
    }
  }

  private var displayedPhases: [ValidationPhase] {
    var phases: [ValidationPhase] = [.setup, .lint, .sast, .build, .test, .health, .pages, .facts, .review]
    if pod.pod.advisoryBrowserQaEnabled == true || displayedAdvisoryQa != nil {
      phases.append(.advisory)
    }
    return phases
  }

  /// The phase to show in the detail panel — user pick, then auto-running, else nil.
  private var displayPhase: ValidationPhase? {
    if let selectedPhase { return selectedPhase }
    return progress?.activePhase
  }

  /// Combined ordered screenshot set for lightbox navigation: smoke -> review -> advisory.
  /// Derived from whichever source is live (progress from events, or final checks).
  private var screenshotSet: [ScreenshotRef] {
    let pageShots = (progress?.pageDetails ?? displayedChecks?.pages ?? []).compactMap {
      validationPageScreenshot($0, proofOfWorkScreenshots: displayedChecks?.proofOfWorkScreenshots)
    }
    let reviewShots = progress?.reviewDetail?.screenshots ?? displayedChecks?.taskReviewScreenshots ?? []
    let advisoryShots: [ScreenshotRef] = {
      guard let advisory = displayedAdvisoryQa else { return [] }
      return advisoryScreenshotSet(advisory)
    }()
    return pageShots + reviewShots + advisoryShots
  }

  private func openLightbox(_ index: Int) {
    lightboxRefs = screenshotSet
    lightboxIndex = index
    isLightboxPresented = true
  }

  /// Context-aware label for the override confirm button.
  private var overrideConfirmLabel: String {
    switch pod.status {
    case .running, .awaitingInput, .paused: return "Dismiss & Notify Agent"
    case .reviewRequired:                   return "Dismiss Finding"
    case .validating:                       return "Queue for Next Run"
    default:                                return "Dismiss"
    }
  }

  /// Whether to show the Guidance option — only meaningful when an agent will run again.
  private var showGuidanceOption: Bool {
    switch pod.status {
    case .running, .awaitingInput, .paused, .validating: return true
    default: return false
    }
  }

  /// Per-phase status, derived from either live progress or the final checks result.
  private func phaseStatus(_ phase: ValidationPhase) -> PhaseStatus {
    if let p = progress { return p.state(for: phase).status }
    guard let c = displayedChecks else { return .notStarted }
    switch phase {
    case .setup:
      return switch c.setup { case true: .passed; case false: .failed; default: .skipped }
    case .build:
      return switch c.build { case true: .passed; case false: .failed; default: .skipped }
    case .test:
      return switch c.tests { case true: .passed; case false: .failed; default: .skipped }
    case .lint:
      return switch c.lint { case true: .passed; case false: .failed; default: .skipped }
    case .sast:
      return switch c.sast { case true: .passed; case false: .failed; default: .skipped }
    case .health:
      if let h = c.healthCheck {
        switch h.status {
        case "fail": return .failed
        case "skip": return .skipped
        default: return .passed
        }
      }
      return c.smoke ? .passed : .notStarted
    case .pages:
      // When the profile has no web UI, health is skipped and pages don't apply.
      if let h = c.healthCheck, h.status == "skip" { return .skipped }
      if let pages = c.pages, !pages.isEmpty {
        return pages.allSatisfy { $0.status == "pass" } ? .passed : .failed
      }
      return .skipped
    case .facts:
      if c.factChecks?.contains(where: { $0.status == "pending_human" }) == true {
        return .pendingHuman
      }
      return switch c.factValidation { case true: .passed; case false: .failed; default: .skipped }
    case .review:
      return switch c.review { case true: .passed; case false: .failed; default: .skipped }
    case .advisory:
      guard let advisory = c.advisoryQa else { return .notStarted }
      switch advisoryDisplayStatus(advisory.status) {
      case "error": return .failed
      case "skipped": return .skipped
      default: return .passed
      }
    }
  }

  private func phaseState(_ phase: ValidationPhase) -> ValidationPhaseState {
    progress?.state(for: phase) ?? ValidationPhaseState(status: phaseStatus(phase))
  }

  private func chipSubLabel(_ phase: ValidationPhase) -> String? {
    if let p = progress {
      switch phase {
      case .pages:
        let count = p.pageCount
        if p.pages.status == .running { return "running…" }
        return count > 0 ? "\(count) pages" : nil
      case .facts:
        let count = p.factTotalCount
        if p.facts.status == .running { return "running…" }
        return count > 0 ? "\(count) facts" : nil
      case .advisory:
        if p.advisory.status == .running { return "running…" }
        if let advisory = displayedAdvisoryQa {
          return advisoryChipSubLabel(advisory)
        }
        return nil
      default:
        if let dur = p.state(for: phase).duration {
          return formatDuration(dur)
        }
        return nil
      }
    }
    // Fallback from checks
    if let c = displayedChecks {
      switch phase {
      case .pages:
        return c.pages.map { "\($0.count) pages" }
      case .facts:
        return c.factChecks.map { "\($0.count) facts" }
      case .advisory:
        if let advisory = c.advisoryQa {
          return advisoryChipSubLabel(advisory)
        }
        return nil
      case .setup:
        return nil
      default:
        return nil
      }
    }
    return nil
  }

  // MARK: - Body

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      headerView
        .padding(.horizontal, 16)
        .padding(.vertical, 10)

      Divider()

      phaseChipRow
        .padding(.horizontal, 16)
        .padding(.vertical, 12)

      Divider()

      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          validationSummaryPanel
          phaseDetailPanel
        }
        .padding(20)
      }
    }
    .task(id: pod.id) {
      await fetchValidationHistory()
    }
    .onChange(of: progress?.attempt) { _, _ in
      selectedPhase = nil
    }
    .onChange(of: selectedHistoryKey) { _, _ in
      selectedPhase = nil
    }
    .onChange(
      of: validationHistoryShouldRefreshAfterAdvisory(
        selectedHistory: selectedHistory,
        progress: pod.validationProgress
      )
    ) { _, shouldRefresh in
      guard shouldRefresh else { return }
      Task {
        await fetchValidationHistory()
      }
    }
    .onChange(of: pod.status) { _, _ in
      updateFromBaseMessage = nil
    }
    .overlay {
      if isLightboxPresented {
        ScreenshotLightbox(
          refs: lightboxRefs,
          currentIndex: $lightboxIndex,
          isPresented: $isLightboxPresented
        )
        .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.18), value: isLightboxPresented)
  }

  // MARK: - Header

  @ViewBuilder
  private var headerView: some View {
    HStack(spacing: 12) {
      HStack(spacing: 12) {
        if let attempts = pod.attempts {
          let attemptLabel = attempts.reworkCount > 0
            ? "Rework \(attempts.reworkCount) — Attempt \(attempts.current) of \(attempts.max)"
            : "Attempt \(attempts.current) of \(attempts.max)"
          Text(attemptLabel)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        } else if let p = progress {
          Text("Attempt \(p.attempt)")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        if let fixLifecycle = validationFixLabel {
          Text(fixLifecycle)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.indigo)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.indigo.opacity(0.12), in: Capsule())
            .help(fixLifecycle)
        }
        validationHistoryMenu
      }
      .layoutPriority(2)

      Spacer(minLength: 8)

      HStack(spacing: 8) {
        if pod.containerUrl != nil,
           pod.status == .validated || pod.status == .validating {
          Button {
            isOpeningApp = true
            Task {
              await actions.openLiveApp(pod.id)
              isOpeningApp = false
            }
          } label: {
            if isOpeningApp {
              HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Starting…").lineLimit(1)
              }
            } else {
              Label("Open App", systemImage: "safari").lineLimit(1)
            }
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .disabled(isOpeningApp)
        }
        if pod.status == .validating || pod.status == .running {
          Button {
            isSkippingValidation = true
            let newSkip = !pod.skipValidation
            Task {
              await actions.setSkipValidation(pod.id, newSkip)
              isSkippingValidation = false
            }
          } label: {
            if isSkippingValidation {
              HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Updating…").lineLimit(1)
              }
            } else if pod.skipValidation {
              Label("Skipping", systemImage: "forward.fill").lineLimit(1)
            } else {
              Label("Skip Validation", systemImage: "forward").lineLimit(1)
            }
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .tint(pod.skipValidation ? .orange : nil)
          .disabled(isSkippingValidation)
        }
        if pod.status == .validating || pod.status == .failed || pod.status == .reviewRequired {
          Button {
            isUpdatingFromBase = true
            updateFromBaseMessage = nil
            Task {
              let result = await actions.updateFromBase(pod.id)
              isUpdatingFromBase = false
              updateFromBaseMessage = updateFromBaseLabel(result)
            }
          } label: {
            if isUpdatingFromBase {
              HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Updating…").lineLimit(1)
              }
            } else {
              Label("Update From Base", systemImage: "arrow.triangle.2.circlepath")
                .lineLimit(1)
            }
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .disabled(isUpdatingFromBase || !pod.hasWorktree || pod.worktreeCompromised)
        }
        if pod.status == .validating {
          Button {
            isInterrupting = true
            Task {
              await actions.interruptValidation(pod.id)
              isInterrupting = false
            }
          } label: {
            if isInterrupting {
              HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Stopping…").lineLimit(1)
              }
            } else {
              Label("Interrupt", systemImage: "stop.fill").lineLimit(1)
            }
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .tint(.orange)
          .disabled(isInterrupting)
        }
        if pod.status == .failed || pod.status == .reviewRequired {
          Button {
            showForceApprovePopover = true
          } label: {
            if isForceApproving {
              HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Approving…").lineLimit(1)
              }
            } else {
              Label("Force Approve", systemImage: "checkmark.seal.fill").lineLimit(1)
            }
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .tint(.green)
          .disabled(isForceApproving)
          .popover(isPresented: $showForceApprovePopover) {
            forceApprovePopover
          }
        }
      }
      .layoutPriority(0)
    }
    if let message = updateFromBaseMessage {
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var validationFixLabel: String? {
    let parts = [pod.prFixAttemptLabel, pod.prFixIterationLabel].compactMap { $0 }
    guard !parts.isEmpty else { return nil }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder
  private var validationHistoryMenu: some View {
    if isLoadingHistory {
      ProgressView()
        .controlSize(.mini)
        .help("Loading validation history")
    } else if !sortedValidationHistory.isEmpty {
      Menu {
        Button {
          selectedHistoryKey = "current"
        } label: {
          validationHistoryMenuItem("Current", selected: selectedHistoryKey == "current")
        }
        Divider()
        ForEach(sortedValidationHistory) { item in
          let key = String(item.attempt)
          Button {
            selectedHistoryKey = key
          } label: {
            validationHistoryMenuItem(
              "Attempt \(item.attempt) · \(item.result.overall)",
              selected: selectedHistoryKey == key
            )
          }
        }
      } label: {
        HStack(spacing: 6) {
          Text(selectedValidationHistoryLabel)
            .font(.caption)
            .lineLimit(1)
            .truncationMode(.tail)
          Spacer(minLength: 4)
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .controlSize(.small)
      .frame(minWidth: 148, idealWidth: 158, maxWidth: 170)
      .layoutPriority(3)
      .help("Show current or previous validation results")
    } else if let historyError {
      Image(systemName: "clock.badge.exclamationmark")
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .help(historyError)
    }
  }

  private var selectedValidationHistoryLabel: String {
    guard let selectedHistory else { return "Attempt: Current" }
    return "Attempt \(selectedHistory.attempt) · \(selectedHistory.result.overall)"
  }

  private func validationHistoryMenuItem(_ title: String, selected: Bool) -> some View {
    HStack {
      Text(title)
      if selected {
        Spacer()
        Image(systemName: "checkmark")
      }
    }
  }

  @ViewBuilder
  private var forceApprovePopover: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Force Approve").font(.headline)
      Text("Bypass validation and mark this pod as validated. Use when the fix is clearly correct but validation is flaky.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      TextField("Reason (optional)", text: $forceApproveReason).textFieldStyle(.roundedBorder)
      HStack {
        Button("Cancel") { showForceApprovePopover = false }
          .buttonStyle(.plain).foregroundStyle(.secondary)
        Spacer()
        Button("Force Approve") {
          let reason = forceApproveReason.isEmpty ? nil : forceApproveReason
          showForceApprovePopover = false
          forceApproveReason = ""
          isForceApproving = true
          Task {
            await actions.forceApprove(pod.id, reason)
            isForceApproving = false
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .tint(.green)
      }
    }
    .padding(16)
    .frame(width: 300)
  }

  // MARK: - Phase chip row

  @ViewBuilder
  private var phaseChipRow: some View {
    let hasAnyData = progress != nil || displayedChecks != nil
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(displayedPhases, id: \.self) { phase in
          PhaseChip(
            phase: phase,
            state: hasAnyData ? phaseState(phase) : ValidationPhaseState(status: .notStarted),
            isSelected: displayPhase == phase,
            subLabel: chipSubLabel(phase)
          ) {
            selectedPhase = selectedPhase == phase ? nil : phase
          }
        }
      }
    }
  }

  // MARK: - Detail panel

  @ViewBuilder
  private var validationSummaryPanel: some View {
    let contract = pod.contract
    let factChecks = progress?.factChecks ?? displayedChecks?.factChecks ?? []
    let passedFacts = factChecks.filter(\.passed).count
    let failedFacts = factChecks.filter { !$0.passed }.count
    let totalFacts = contract?.requiredFacts.count ?? factChecks.count
    let reviewIssueCount = progress?.reviewDetail?.issues.count ?? displayedChecks?.reviewIssues?.count ?? 0

    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: validationSummaryIcon)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(validationSummaryColor)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 3) {
          Text(validationSummaryTitle)
            .font(.callout.weight(.semibold))
          Text(validationSummarySubtitle)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
      }

      HStack(spacing: 8) {
        summaryChip(
          label: "Suite",
          value: displayedChecks?.validationSuite ?? pod.pod.validationSuite,
          color: .secondary
        )
        summaryChip(
          label: "Phases",
          value: "\(displayedPhases.filter { phaseStatus($0) == .passed }.count)/\(displayedPhases.count)",
          color: validationSummaryColor
        )
        if let contract {
          summaryChip(label: "Scenarios", value: "\(contract.scenarios.count)", color: .blue)
          summaryChip(label: "Facts", value: "\(passedFacts)/\(totalFacts)", color: failedFacts > 0 ? .red : .green)
          summaryChip(label: "Human Review", value: "\(contract.humanReview.count)", color: .purple)
        }
        if reviewIssueCount > 0 {
          summaryChip(label: "Findings", value: "\(reviewIssueCount)", color: .red)
        }
      }
    }
    .padding(14)
    .background(validationSummaryColor.opacity(0.06))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(validationSummaryColor.opacity(0.16), lineWidth: 1))
  }

  private var validationSummaryTitle: String {
    if pod.validationWaiver != nil {
      return "Approved with validation waiver"
    }
    if let failed = displayedPhases.first(where: { phaseStatus($0) == .failed }) {
      return "\(failed.displayName) needs attention"
    }
    if let pending = displayedPhases.first(where: { phaseStatus($0) == .pendingHuman }) {
      return "\(pending.displayName) needs human decision"
    }
    if displayedPhases.contains(where: { phaseStatus($0) == .running }) {
      return "Validation is running"
    }
    if displayedChecks?.allPassed == true {
      return "Validation passed"
    }
    if displayedChecks == nil && progress == nil {
      return "Validation has not started"
    }
    return "Validation status"
  }

  private var validationSummarySubtitle: String {
    let contractSummary = pod.contract.map {
      "\($0.scenarios.count) scenarios, \($0.requiredFacts.count) required facts, \($0.humanReview.count) human review checks."
    }
    if let waiver = pod.validationWaiver {
      let facts = waiver.failedFactIds.isEmpty ? "" : " Failed facts: \(waiver.failedFactIds.joined(separator: ", "))."
      return ["Human override: \(waiver.reason).\(facts)", contractSummary].compactMap { $0 }.joined(separator: " ")
    }
    if let failed = displayedPhases.first(where: { phaseStatus($0) == .failed }) {
      return [failed.displayName + " failed.", contractSummary].compactMap { $0 }.joined(separator: " ")
    }
    if let pending = displayedPhases.first(where: { phaseStatus($0) == .pendingHuman }) {
      return [pending.displayName + " is pending human decision.", contractSummary].compactMap { $0 }.joined(separator: " ")
    }
    if let active = progress?.activePhase {
      return [active.displayName + " is currently running.", contractSummary].compactMap { $0 }.joined(separator: " ")
    }
    return contractSummary ?? "Build, checks, facts, and review results are shown below."
  }

  private var validationSummaryIcon: String {
    if pod.validationWaiver != nil { return "checkmark.seal.fill" }
    if displayedPhases.contains(where: { phaseStatus($0) == .failed }) { return "xmark.seal.fill" }
    if displayedPhases.contains(where: { phaseStatus($0) == .pendingHuman }) { return "questionmark.circle.fill" }
    if displayedPhases.contains(where: { phaseStatus($0) == .running }) { return "arrow.triangle.2.circlepath" }
    if displayedChecks?.allPassed == true { return "checkmark.seal.fill" }
    return "checkmark.seal"
  }

  private var validationSummaryColor: Color {
    if pod.validationWaiver != nil { return .orange }
    if displayedPhases.contains(where: { phaseStatus($0) == .failed }) { return .red }
    if displayedPhases.contains(where: { phaseStatus($0) == .pendingHuman }) { return .orange }
    if displayedPhases.contains(where: { phaseStatus($0) == .running }) { return .blue }
    if displayedChecks?.allPassed == true { return .green }
    return .secondary
  }

  private func summaryChip(label: String, value: String, color: Color) -> some View {
    HStack(spacing: 5) {
      Text(label)
        .font(.caption2)
        .foregroundStyle(.secondary)
      Text(value)
        .font(.system(.caption2, design: .monospaced).weight(.semibold))
        .foregroundStyle(color)
        .lineLimit(1)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(color.opacity(0.10), in: Capsule())
  }

  @ViewBuilder
  private var phaseDetailPanel: some View {
    if let phase = displayPhase {
      switch phase {
      case .setup:   setupDetail
      case .build:   buildDetail
      case .test:    testDetail
      case .lint:    lintDetail
      case .sast:    sastDetail
      case .health:  healthDetail
      case .pages:   pagesDetail
      case .facts:   factsDetail
      case .review:  reviewDetail
      case .advisory: advisoryDetail
      }
    } else {
      if progress == nil && displayedChecks == nil {
        // Empty state — no validation run yet
        VStack(spacing: 10) {
          Image(systemName: "checkmark.seal")
            .font(.system(size: 32))
            .foregroundStyle(.tertiary)
          Text("No validation results yet")
            .font(.subheadline)
            .foregroundStyle(.secondary)
          if pod.status == .validating {
            ProgressView("Validating…").font(.caption)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 40)
      } else {
        // Prompt to click a chip
        Text("Select a phase above to see details")
          .font(.caption)
          .foregroundStyle(.tertiary)
          .frame(maxWidth: .infinity)
          .padding(.top, 12)
      }
    }
  }

  // MARK: - Per-phase detail content

  private var setupFailed: Bool {
    phaseStatus(.setup) == .failed
  }

  @ViewBuilder
  private var setupDetail: some View {
    let status = phaseStatus(.setup)
    let output: String? = progress?.setupOutput ?? displayedChecks?.setupOutput
    let dur: Int? = progress?.setup.duration

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Setup completed", failLabel: "Setup failed",
                     skipLabel: "No validation setup configured", duration: dur)
      if status == .failed {
        Text("Downstream validation phases were skipped.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let output, !output.isEmpty {
        outputBlock(title: "Setup Output", text: output, expanded: $expandedSetupOutput, color: status.color)
      }
    }
  }

  @ViewBuilder
  private var buildDetail: some View {
    let status = phaseStatus(.build)
    let output: String? = progress?.buildOutput ?? displayedChecks?.buildOutput
    let dur: Int? = progress?.build.duration

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Build succeeded", failLabel: "Build failed",
                     skipLabel: setupFailed ? "Setup failed — build skipped" : "Build skipped", duration: dur)
      if let output, !output.isEmpty {
        outputBlock(title: "Build Output", text: output, expanded: $expandedBuildOutput, color: status.color)
      }
    }
  }

  @ViewBuilder
  private var testDetail: some View {
    let status = phaseStatus(.test)
    let output: String? = progress?.testOutput ?? displayedChecks?.testOutput
    let dur: Int? = progress?.test.duration
    let smokeOk = !setupFailed && (displayedChecks?.smoke ?? (progress?.build.status == .passed))

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "All tests passed", failLabel: "Tests failed",
                     skipLabel: setupFailed
                       ? "Setup failed — tests skipped"
                       : (smokeOk ? "No test command configured" : "Build failed — tests skipped"),
                     duration: dur)
      if let output, !output.isEmpty {
        outputBlock(title: "Test Output", text: output, expanded: $expandedTestOutput, color: status.color)
      }
    }
  }

  @ViewBuilder
  private var lintDetail: some View {
    let status = phaseStatus(.lint)
    let output: String? = progress?.lintOutput ?? displayedChecks?.lintOutput
    let dur: Int? = progress?.lint.duration
    let buildOk = !setupFailed && (displayedChecks?.smoke != false || (progress?.build.status == .passed))

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Lint passed", failLabel: "Lint failed",
                     skipLabel: setupFailed
                       ? "Setup failed — lint skipped"
                       : (buildOk ? "No lint command configured" : "Build failed — lint skipped"),
                     duration: dur)
      if let output, !output.isEmpty {
        outputBlock(title: "Lint Output", text: output, expanded: $expandedLintOutput, color: status.color)
      }
    }
  }

  @ViewBuilder
  private var sastDetail: some View {
    let status = phaseStatus(.sast)
    let output: String? = progress?.sastOutput ?? displayedChecks?.sastOutput
    let dur: Int? = progress?.sast.duration
    let buildOk = !setupFailed && (displayedChecks?.smoke != false || (progress?.build.status == .passed))

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Security scan passed", failLabel: "Security scan failed",
                     skipLabel: setupFailed
                       ? "Setup failed — SAST skipped"
                       : (buildOk ? "No SAST command configured" : "Build failed — SAST skipped"),
                     duration: dur)
      if let output, !output.isEmpty {
        outputBlock(title: "Security Scan Output", text: output, expanded: $expandedSastOutput, color: status.color)
      }
    }
  }

  @ViewBuilder
  private var healthDetail: some View {
    let status = phaseStatus(.health)
    let health: HealthCheckDetail? = progress?.healthDetail ?? displayedChecks?.healthCheck
    let dur: Int? = progress?.health.duration

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Health check passed",
                     failLabel: "Health check failed", skipLabel: "Health check skipped",
                     duration: dur)
      if let h = health, h.status != "skip" {
        VStack(alignment: .leading, spacing: 6) {
          Label(h.url, systemImage: "link")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(2)
          HStack(spacing: 8) {
            if let code = h.responseCode {
              Text("HTTP \(code)")
                .font(.caption.weight(.medium))
                .foregroundStyle(h.status == "pass" ? .green : .red)
            } else if h.status == "fail" {
              Text("No response")
                .font(.caption)
                .foregroundStyle(.red)
            }
            Text("\(h.duration)ms")
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
          if let body = h.responseBody, !body.isEmpty {
            ScrollView([.vertical, .horizontal], showsIndicators: true) {
              Text(body)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 160)
            .padding(8)
            .background(Color.black.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: 6))
          }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
      }
    }
  }

  @ViewBuilder
  private var pagesDetail: some View {
    let status = phaseStatus(.pages)
    let pages: [PageDetail]? = progress?.pageDetails ?? displayedChecks?.pages

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "All pages passed",
                     failLabel: "Page checks failed", skipLabel: "No pages configured")
      if let pages, !pages.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(pages.enumerated()), id: \.offset) { _, page in
            pageRow(page)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func pageRow(_ page: PageDetail) -> some View {
    let screenshot = validationPageScreenshot(
      page,
      proofOfWorkScreenshots: displayedChecks?.proofOfWorkScreenshots
    )

    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: page.status == "pass" ? "checkmark.circle.fill" : "xmark.circle.fill")
          .font(.system(size: 11))
          .foregroundStyle(page.status == "pass" ? Color.green : Color.red)
        Text(page.path)
          .font(.system(.caption, design: .monospaced).weight(.medium))
        Spacer()
        Text("\(page.loadTime)ms")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
      if !page.consoleErrors.isEmpty {
        ForEach(Array(page.consoleErrors.enumerated()), id: \.offset) { _, err in
          HStack(alignment: .top, spacing: 4) {
            Image(systemName: "exclamationmark.triangle")
              .font(.system(size: 9))
              .foregroundStyle(.orange)
              .padding(.top, 2)
            Text(err)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.orange.opacity(0.9))
              .lineLimit(3)
          }
        }
      }
      ForEach(Array(page.assertions.filter { !$0.passed }.enumerated()), id: \.offset) { _, a in
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 9))
            .foregroundStyle(.red)
            .padding(.top, 2)
          VStack(alignment: .leading, spacing: 1) {
            Text("\(a.type): \(a.selector)")
              .font(.system(.caption2, design: .monospaced))
            if let expected = a.expected, let actual = a.actual {
              Text("expected \(expected), got \(actual)")
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
          }
        }
      }
      if let ref = screenshot {
        ScreenshotThumbnail(ref: ref, allRefs: screenshotSet, onOpen: { openLightbox($0) })
      }
    }
    .padding(10)
    .background(page.status == "pass"
                ? Color(nsColor: .controlBackgroundColor)
                : Color.red.opacity(0.05))
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }

  @ViewBuilder
  private var factsDetail: some View {
    let status = phaseStatus(.facts)
    let factChecks: [FactCheckDetail]? = progress?.factChecks ?? displayedChecks?.factChecks

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Required facts passed",
                     failLabel: "Required facts failed", skipLabel: "No required facts configured")
      if let contract = pod.contract {
        contractDetail(contract, factChecks: factChecks)
      } else if let factChecks, !factChecks.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(factChecks.enumerated()), id: \.offset) { _, check in
            factEvidenceCard(check)
          }
        }
      }
      correctionMessageBlock
    }
  }

  @ViewBuilder
  private func contractDetail(
    _ contract: SpecContractResponse,
    factChecks: [FactCheckDetail]?
  ) -> some View {
    let evidenceByFact = Dictionary(uniqueKeysWithValues: (factChecks ?? []).map { ($0.factId, $0) })
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(contract.title)
          .font(.callout.weight(.semibold))
        Text("\(contract.scenarios.count) scenarios · \(contract.requiredFacts.count) required facts · \(contract.humanReview.count) review checks")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }

      if !contract.scenarios.isEmpty {
        CollapsibleSection(title: "Scenarios", icon: "list.bullet.rectangle", initiallyExpanded: true) {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(contract.scenarios, id: \.id) { scenario in
              scenarioCard(
                scenario,
                facts: contract.requiredFacts.filter { $0.proves.contains(scenario.id) },
                evidenceByFact: evidenceByFact
              )
            }
          }
        }
      }

      if !contract.requiredFacts.isEmpty {
        CollapsibleSection(title: "Required Facts", icon: "checkmark.seal", initiallyExpanded: true) {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(contract.requiredFacts, id: \.id) { fact in
              requiredFactCard(fact, evidence: evidenceByFact[fact.id])
            }
          }
        }
      }

      if !contract.humanReview.isEmpty {
        CollapsibleSection(title: "Human Review", icon: "person.crop.circle.badge.questionmark", initiallyExpanded: false) {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(contract.humanReview, id: \.id) { item in
              VStack(alignment: .leading, spacing: 4) {
                Text(item.id).font(.caption.weight(.semibold))
                Text(item.criterion).font(.caption)
                Text(item.reason).font(.caption2).foregroundStyle(.secondary)
              }
              .padding(10)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(Color(nsColor: .controlBackgroundColor))
              .clipShape(RoundedRectangle(cornerRadius: 8))
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func scenarioCard(
    _ scenario: ContractScenarioResponse,
    facts: [RequiredFactResponse],
    evidenceByFact: [String: FactCheckDetail]
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "list.bullet.rectangle")
          .font(.system(size: 12))
          .foregroundStyle(.blue)
        Text(scenario.id)
          .font(.callout.weight(.semibold))
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
        Spacer(minLength: 0)
        Text("scenario")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.blue)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Color.blue.opacity(0.12), in: Capsule())
      }

      VStack(alignment: .leading, spacing: 6) {
        scenarioStepRow(label: "G", title: "Given", lines: scenario.given)
        scenarioStepRow(label: "W", title: "When", lines: scenario.when)
        scenarioStepRow(label: "T", title: "Then", lines: scenario.then)
      }

      if !facts.isEmpty {
        ViewThatFits(in: .horizontal) {
          HStack(alignment: .center, spacing: 6) {
            scenarioProofLabel
            ForEach(facts, id: \.id) { fact in
              scenarioFactChip(fact, evidence: evidenceByFact[fact.id])
            }
          }

          VStack(alignment: .leading, spacing: 6) {
            scenarioProofLabel
            HStack(spacing: 6) {
              ForEach(facts, id: \.id) { fact in
                scenarioFactChip(fact, evidence: evidenceByFact[fact.id])
              }
            }
          }
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.blue.opacity(0.12), lineWidth: 1))
  }

  @ViewBuilder
  private func scenarioStepRow(label: String, title: String, lines: [String]) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Text(label)
        .font(.system(size: 9, weight: .bold, design: .rounded))
        .foregroundStyle(.blue)
        .frame(width: 18, height: 18)
        .background(Color.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
      Text(title.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.tertiary)
        .tracking(0.35)
        .frame(width: 38, alignment: .leading)
        .padding(.top, 3)
      VStack(alignment: .leading, spacing: 3) {
        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
          Text(line)
            .font(.caption)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }
      }
      .padding(.top, 2)
    }
  }

  private var scenarioProofLabel: some View {
    Label("proven by", systemImage: "checkmark.seal")
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(.secondary)
      .labelStyle(.titleAndIcon)
  }

  private func factStatusParts(evidence: FactCheckDetail?) -> (label: String, color: Color, icon: String) {
    guard let evidence else {
      return ("awaiting evidence", .secondary, "clock")
    }

    switch evidence.status {
    case "pending_human":
      return ("pending human", .orange, "questionmark.circle.fill")
    case "waived":
      return ("waived", .green, "checkmark.seal.fill")
    case "replaced":
      return ("replaced", .green, "arrow.triangle.2.circlepath")
    case "pass":
      return ("passed", .green, "checkmark.circle.fill")
    case "fail":
      return ("failed", .red, "xmark.circle.fill")
    default:
      return evidence.passed
        ? ("passed", .green, "checkmark.circle.fill")
        : ("failed", .red, "xmark.circle.fill")
    }
  }

  private func scenarioFactChip(_ fact: RequiredFactResponse, evidence: FactCheckDetail?) -> some View {
    let status = factStatusParts(evidence: evidence)
    return HStack(spacing: 4) {
      Image(systemName: status.icon)
        .font(.system(size: 9, weight: .semibold))
      Text(fact.id)
        .font(.system(.caption2, design: .monospaced).weight(.semibold))
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .foregroundStyle(status.color)
    .padding(.horizontal, 7)
    .padding(.vertical, 3)
    .background(status.color.opacity(0.10), in: Capsule())
  }

  @ViewBuilder
  private func requiredFactCard(_ fact: RequiredFactResponse, evidence: FactCheckDetail?) -> some View {
    let status = factStatusParts(evidence: evidence)
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(status.color.opacity(evidence == nil ? 0.35 : 0.75))
        .frame(width: 3)

      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: status.icon)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(status.color)
            .padding(.top, 1)
          VStack(alignment: .leading, spacing: 3) {
            Text(fact.id)
              .font(.callout.weight(.semibold))
              .lineLimit(1)
              .truncationMode(.middle)
              .textSelection(.enabled)
            HStack(spacing: 6) {
              Text(fact.kind)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
              Text(fact.artifact.change)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Color.secondary.opacity(0.10), in: Capsule())
            }
          }
          Spacer(minLength: 4)
          if factCanApproveWaiver(evidence) {
            factWaiverButton(factId: fact.id, evidence: evidence)
          }
          factStatusBadge(evidence: evidence)
        }

        contractMetaRow(label: "proves", value: fact.proves.joined(separator: ", "))
        contractMetaRow(label: "artifact", value: fact.artifact.path, monospaced: true)
        contractMetaRow(label: "command", value: fact.command, monospaced: true)

        if let evidence {
          factEvidenceBody(evidence)
        } else {
          HStack(spacing: 8) {
            Image(systemName: "hourglass")
              .font(.system(size: 11))
              .foregroundStyle(.secondary)
            Text("Awaiting evidence from Autopod validator.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color(nsColor: .windowBackgroundColor).opacity(0.6))
          .clipShape(RoundedRectangle(cornerRadius: 6))
        }
      }
      .padding(12)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(status.color.opacity(0.15), lineWidth: 1))
  }

  private func contractMetaRow(label: String, value: String, monospaced: Bool = false) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Text(label)
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.tertiary)
        .textCase(.uppercase)
        .tracking(0.35)
        .frame(width: 58, alignment: .leading)
      Text(value)
        .font(monospaced ? .system(.caption, design: .monospaced) : .caption)
        .foregroundStyle(.secondary)
        .lineLimit(monospaced ? 2 : nil)
        .truncationMode(.middle)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
  }

  private func factStatusBadge(evidence: FactCheckDetail?) -> some View {
    let status = factStatusParts(evidence: evidence)
    return Text(status.label)
      .font(.system(.caption2, design: .monospaced).weight(.semibold))
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(status.color.opacity(0.12), in: Capsule())
      .foregroundStyle(status.color)
  }

  private func factCanApproveWaiver(_ evidence: FactCheckDetail?) -> Bool {
    guard evidence?.status == "pending_human" else { return false }
    return pod.status == .failed || pod.status == .reviewRequired
  }

  private func factWaiverButton(factId: String, evidence: FactCheckDetail?) -> some View {
    let isApproving = approvingFactWaiverIds.contains(factId)
    return Button {
      factWaiverReason = ""
      factWaiverPopoverFactId = factId
    } label: {
      if isApproving {
        HStack(spacing: 4) {
          ProgressView().controlSize(.mini)
          Text("Approving…").lineLimit(1)
        }
      } else {
        Label("Approve Waiver", systemImage: "checkmark.seal.fill").lineLimit(1)
      }
    }
    .buttonStyle(.bordered)
    .controlSize(.mini)
    .tint(.green)
    .disabled(isApproving)
    .popover(isPresented: Binding(
      get: { factWaiverPopoverFactId == factId },
      set: { if !$0 { factWaiverPopoverFactId = nil } }
    )) {
      factWaiverPopover(factId: factId, evidence: evidence)
    }
  }

  @ViewBuilder
  private func factWaiverPopover(factId: String, evidence: FactCheckDetail?) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Approve Fact Waiver").font(.headline)
      Text("Mark this required fact as waived and re-run validation so later gates can continue.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if let evidence {
        Text(evidence.reasoning)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      TextField("Reason (optional)", text: $factWaiverReason).textFieldStyle(.roundedBorder)
      HStack {
        Button("Cancel") { factWaiverPopoverFactId = nil }
          .buttonStyle(.plain).foregroundStyle(.secondary)
        Spacer()
        Button("Approve Waiver") {
          let fid = factId
          let reason = factWaiverReason.isEmpty ? nil : factWaiverReason
          factWaiverPopoverFactId = nil
          factWaiverReason = ""
          approvingFactWaiverIds.insert(fid)
          Task {
            await actions.approveFactWaiver(pod.id, fid, reason)
            approvingFactWaiverIds.remove(fid)
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .tint(.green)
      }
    }
    .padding(16)
    .frame(width: 320)
  }

  @ViewBuilder
  private func factEvidenceCard(_ check: FactCheckDetail) -> some View {
    let status = factStatusParts(evidence: check)
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(status.color.opacity(0.7))
        .frame(width: 3)
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: status.icon)
            .font(.system(size: 13))
            .foregroundStyle(status.color)
            .padding(.top, 1)
          VStack(alignment: .leading, spacing: 2) {
            Text(check.factId)
              .font(.callout.weight(.medium))
            Text(check.kind ?? "fact")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.secondary)
            Text(check.artifactPath)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 4)
          if factCanApproveWaiver(check) {
            factWaiverButton(factId: check.factId, evidence: check)
          }
          factBadge("evidence")
        }
        factEvidenceBody(check)
      }
      .padding(10)
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(status.color.opacity(0.15), lineWidth: 1))
  }

  @ViewBuilder
  private func factEvidenceBody(_ check: FactCheckDetail) -> some View {
    HStack(spacing: 8) {
      if let exitCode = check.exitCode {
        Text("exit \(exitCode)")
      }
      if let durationMs = check.durationMs {
        Text(formatDuration(durationMs))
      }
      if let artifact = check.artifact {
        Text(artifact.exists ? "artifact exists" : "artifact missing")
        Text(artifact.changed ? "changed" : "unchanged")
      }
    }
    .font(.caption2)
    .foregroundStyle(.secondary)
    Text(check.command)
      .font(.system(.caption2, design: .monospaced))
      .foregroundStyle(.secondary)
      .textSelection(.enabled)
    if let hash = check.artifact?.hash {
      Text("sha256:\(hash)")
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.tertiary)
        .lineLimit(1)
        .truncationMode(.middle)
        .textSelection(.enabled)
    }
    Text(check.reasoning)
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(nsColor: .windowBackgroundColor).opacity(0.6))
      .clipShape(RoundedRectangle(cornerRadius: 4))
    if let attachments = check.attachments, !attachments.isEmpty {
      ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
        Text("\(attachment.kind): \(attachment.path)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }
    }
    if let output = factCommandOutput(check) {
      factCommandOutputBlock(check, text: output)
    }
  }

  @ViewBuilder
  private func factCommandOutputBlock(_ check: FactCheckDetail, text: String) -> some View {
    let color = factCommandOutputColor(check)
    DisclosureGroup(isExpanded: factOutputExpandedBinding(for: check.factId)) {
      ScrollView([.vertical, .horizontal], showsIndicators: true) {
        Text(text)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(color.opacity(0.9))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 300)
      .padding(8)
      .background(Color.black.opacity(0.3))
      .clipShape(RoundedRectangle(cornerRadius: 6))
    } label: {
      Text("Fact Command Output")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
    }
    .tint(color)
  }

  private func factCommandOutput(_ check: FactCheckDetail) -> String? {
    let stdout = check.stdout?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let stderr = check.stderr?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    if !stdout.isEmpty && !stderr.isEmpty {
      return "stderr:\n\(stderr)\n\nstdout:\n\(stdout)"
    }
    if !stderr.isEmpty { return stderr }
    if !stdout.isEmpty { return stdout }
    return nil
  }

  private func factCommandOutputColor(_ check: FactCheckDetail) -> Color {
    switch check.status {
    case "fail", "pending_human":
      return .red
    case "pass", "waived", "replaced":
      return .blue
    default:
      return check.passed ? .blue : .red
    }
  }

  private func factOutputExpandedBinding(for factId: String) -> Binding<Bool> {
    Binding(
      get: { expandedFactOutputIds.contains(factId) },
      set: { expanded in
        if expanded {
          expandedFactOutputIds.insert(factId)
        } else {
          expandedFactOutputIds.remove(factId)
        }
      }
    )
  }

  @ViewBuilder
  private var reviewDetail: some View {
    let status = phaseStatus(.review)
    let detail: ReviewPhaseDetail? = progress?.reviewDetail
    let issues: [String] = detail?.issues ?? displayedChecks?.reviewIssues ?? []
    let reasoning: String? = detail?.reasoning ?? displayedChecks?.reviewReasoning
    let skipReason: String? = displayedChecks?.reviewSkipReason
    let skipKind: String? = displayedChecks?.reviewSkipKind
    let reqs: [RequirementCheckDetail]? = detail?.requirementsCheck ?? displayedChecks?.requirementsCheck
    let screenshots: [ScreenshotRef] = detail?.screenshots ?? displayedChecks?.taskReviewScreenshots ?? []
    let issueTexts = issues.isEmpty
      ? displayedChecks?.reviewFindings?.map(\.description) ?? []
      : issues
    let findingItems = reviewFindingItems(from: issueTexts)

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(
        status: status,
        passLabel: detail?.status == "uncertain" ? "Review uncertain — treated as pass" : "AI review passed",
        failLabel: "Review flagged issues",
        skipLabel: reviewSkipLabel(kind: skipKind, reason: skipReason)
      )
      if findingItems.isEmpty, let reasoning, !reasoning.isEmpty {
        Text(reasoning)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if !findingItems.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("Review Findings")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(findingItems) { item in
            reviewFindingRow(item)
          }
        }
      }
      if let reqs, !reqs.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("Requirements Coverage")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(Array(reqs.enumerated()), id: \.offset) { _, req in
            HStack(alignment: .top, spacing: 6) {
              Image(systemName: req.met ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 9))
                .foregroundStyle(req.met ? .green : .red)
                .padding(.top, 2)
              VStack(alignment: .leading, spacing: 1) {
                Text(req.criterion).font(.caption)
                if let note = req.note {
                  Text(note).font(.caption2).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
      }
      if !screenshots.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("Review Screenshots")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(screenshots) { ss in
            ScreenshotThumbnail(ref: ss, allRefs: screenshotSet, onOpen: { openLightbox($0) })
          }
        }
      }
      correctionMessageBlock
      if let verdict = pod.preSubmitReview {
        preSubmitReviewDisclosure(verdict)
      }
    }
  }

  private func advisoryScreenshotSet(_ advisory: AdvisoryQaDetail) -> [ScreenshotRef] {
    uniqueAdvisoryScreenshots(advisory.screenshots + advisory.observations.flatMap(\.screenshots))
  }

  private func advisoryAdditionalScreenshots(_ advisory: AdvisoryQaDetail) -> [ScreenshotRef] {
    let observationScreenshotIds = Set(advisory.observations.flatMap(\.screenshots).map(\.id))
    return uniqueAdvisoryScreenshots(advisory.screenshots.filter { !observationScreenshotIds.contains($0.id) })
  }

  private func advisoryObservationScreenshots(_ observation: AdvisoryQaObservationDetail) -> [ScreenshotRef] {
    uniqueAdvisoryScreenshots(observation.screenshots)
  }

  private func uniqueAdvisoryScreenshots(_ screenshots: [ScreenshotRef]) -> [ScreenshotRef] {
    var seen: Set<String> = []
    return screenshots.filter { ref in
      seen.insert(ref.id).inserted
    }
  }

  private func advisoryPreviewText(_ text: String, limit: Int = 220) -> String {
    let compact = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if compact.count <= limit { return compact }
    return String(compact.prefix(max(0, limit - 3))).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
  }

  private func advisoryDisplayStatus(_ status: String) -> String {
    switch status {
    case "complete", "skipped", "error", "uncertain":
      return status
    case "skip":
      return "skipped"
    case "fail":
      return "error"
    case "pass":
      return "complete"
    default:
      return "uncertain"
    }
  }

  private func advisoryChipSubLabel(_ advisory: AdvisoryQaDetail) -> String? {
    let observationCount = advisory.observations.count
    if observationCount > 0 { return "\(observationCount) notes" }
    return advisory.durationMs.map(formatDuration)
  }

  @ViewBuilder
  private var advisoryDetail: some View {
    if let advisory = displayedAdvisoryQa {
      advisoryQaDetail(advisory)
    } else {
      phaseStatusRow(
        status: phaseStatus(.advisory),
        passLabel: "Advisory browser QA completed",
        failLabel: "Advisory browser QA found concerns",
        skipLabel: "Advisory browser QA skipped"
      )
    }
  }

  @ViewBuilder
  private func advisoryQaDetail(_ advisory: AdvisoryQaDetail) -> some View {
    let displayStatus = advisoryDisplayStatus(advisory.status)
    let color = Color.secondary
    let additionalScreenshots = advisoryAdditionalScreenshots(advisory)

    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: advisoryIcon(displayStatus))
          .font(.system(size: 14))
          .foregroundStyle(color)
        VStack(alignment: .leading, spacing: 1) {
          Text("Advisory QA \(displayStatus)")
            .font(.callout)
            .foregroundStyle(color)
          HStack(spacing: 8) {
            if let model = advisory.model {
              Text(model)
            }
            if let durationMs = advisory.durationMs {
              Text(formatDuration(durationMs))
            }
          }
          .font(.caption2)
          .foregroundStyle(.tertiary)
        }
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(nsColor: .controlBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 8))

      if !advisory.reasoning.isEmpty {
        advisoryReasoningBlock(advisory.reasoning)
      }

      if !advisory.observations.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("Observations")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(advisory.observations, id: \.id) { observation in
            advisoryObservationRow(observation)
          }
        }
      }

      if !additionalScreenshots.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("Additional Screenshots")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(additionalScreenshots) { screenshot in
            ScreenshotThumbnail(ref: screenshot, allRefs: screenshotSet, onOpen: { openLightbox($0) })
          }
        }
      }
    }
  }

  @ViewBuilder
  private func advisoryReasoningBlock(_ reasoning: String) -> some View {
    let preview = advisoryPreviewText(reasoning)
    if preview == reasoning {
      Text(reasoning)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    } else {
      DisclosureGroup {
        Text(reasoning)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      } label: {
        Text(preview)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func advisoryIcon(_ displayStatus: String) -> String {
    switch displayStatus {
    case "skipped": return "minus.circle"
    case "uncertain": return "questionmark.circle"
    default: return "info.circle"
    }
  }

  @ViewBuilder
  private func advisoryObservationRow(_ observation: AdvisoryQaObservationDetail) -> some View {
    let color = Color.secondary
    let screenshots = advisoryObservationScreenshots(observation)
    let extraScreenshots = Array(screenshots.dropFirst())
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .top, spacing: 6) {
        Image(systemName: advisoryObservationIcon(observation.status))
          .font(.system(size: 11))
          .foregroundStyle(color)
          .padding(.top, 2)
        VStack(alignment: .leading, spacing: 2) {
          Text(observation.summary)
            .font(.caption.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
          if let scenarioId = observation.scenarioId {
            Text(scenarioId)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.tertiary)
          }
        }
        Spacer(minLength: 4)
        Text(observation.status)
          .font(.system(.caption2, design: .monospaced).weight(.semibold))
          .foregroundStyle(color)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(color.opacity(0.10), in: Capsule())
      }
      advisoryObservationDetailDisclosure(observation)
      if let screenshot = screenshots.first {
        ScreenshotThumbnail(
          ref: screenshot,
          allRefs: screenshotSet,
          onOpen: { openLightbox($0) },
          maxHeight: 220
        )
      }
      if !extraScreenshots.isEmpty {
        DisclosureGroup {
          ForEach(extraScreenshots) { screenshot in
            ScreenshotThumbnail(
              ref: screenshot,
              allRefs: screenshotSet,
              onOpen: { openLightbox($0) },
              maxHeight: 220
            )
          }
        } label: {
          Text("\(extraScreenshots.count) more screenshot\(extraScreenshots.count == 1 ? "" : "s")")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(color.opacity(0.14), lineWidth: 1))
  }

  @ViewBuilder
  private func advisoryObservationDetailDisclosure(_ observation: AdvisoryQaObservationDetail) -> some View {
    let details = observation.details?.trimmingCharacters(in: .whitespacesAndNewlines)
    let suggestedFacts = observation.suggestedFacts ?? []
    if details?.isEmpty == false || !suggestedFacts.isEmpty {
      DisclosureGroup {
        VStack(alignment: .leading, spacing: 6) {
          if let details, !details.isEmpty {
            Text(details)
              .font(.caption2)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
          if !suggestedFacts.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
              Text("Suggested facts")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
              ForEach(suggestedFacts, id: \.self) { fact in
                Text(fact)
                  .font(.caption2)
                  .foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
          }
        }
      } label: {
        Text("Details")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
      }
    }
  }

  private func advisoryObservationIcon(_ status: String) -> String {
    switch status {
    case "pass": return "checkmark.circle"
    default: return "questionmark.circle"
    }
  }

  // MARK: - Update From Base helpers

  private func updateFromBaseLabel(_ response: UpdateFromBaseResponse?) -> String? {
    guard let response else { return nil }
    let branch = response.baseBranch ?? "base"
    switch response.action {
    case "queued_after_abort":
      return "Validation is stopping. Update from base will run next."
    case "already_up_to_date":
      return "Already contains latest \(branch)."
    case "rebased":
      return "Rebased onto \(branch). Validation restarted."
    case "conflict":
      let files = response.conflicts?.map { "  \($0)" }.joined(separator: "\n") ?? ""
      return "Rebase conflict while updating from \(branch):\n\(files)"
    default:
      return nil
    }
  }

  // MARK: - Shared helpers

  @ViewBuilder
  private var correctionMessageBlock: some View {
    if let msg = displayedChecks?.correctionMessage {
      VStack(alignment: .leading, spacing: 6) {
        Text("Feedback Sent to Agent")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        ScrollView {
          Text(msg)
            .font(.system(.caption2, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 300)
        .padding(8)
        .background(Color.black.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 6))
      }
    }
  }

  /// Label for the Review chip when status is .skipped. `kind` carries the
  /// machine-readable category; `reason` is the original free-form string we
  /// fall back to when no kind is known (legacy results from before the
  /// tier-1 gate landed).
  private func reviewSkipLabel(kind: String?, reason: String?) -> String {
    switch kind {
    case "upstream-failed": return "Skipped — earlier validation phases failed"
    case "profile-skip": return "AI review disabled by profile"
    case "review-timeout": return reason ?? "Review timed out"
    case "review-failed": return reason ?? "Review failed"
    case "no-changes": return reason ?? "No code changes to review"
    default: return reason ?? "Review skipped"
    }
  }

  private func reviewFindingItems(from issues: [String]) -> [ReviewFindingItem] {
    issues.enumerated().map { idx, issue in
      let findingId = displayedChecks?.reviewFindings?.first(where: { $0.description == issue })?.id
        ?? "review-issue-\(idx)"
      let parsed = parseReviewIssue(issue)
      return ReviewFindingItem(
        id: findingId,
        original: issue,
        severity: parsed.severity,
        title: parsed.title,
        detail: parsed.detail,
        location: parsed.location
      )
    }
  }

  private func parseReviewIssue(_ issue: String) -> ReviewFindingItem {
    var text = issue.trimmingCharacters(in: .whitespacesAndNewlines)
    let severity: String?

    if text.hasPrefix("["), let end = text.firstIndex(of: "]") {
      let rawSeverity = String(text[text.index(after: text.startIndex)..<end])
      severity = rawSeverity.uppercased()
      text = String(text[text.index(after: end)...]).trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
      severity = nil
    }

    let location = extractReviewLocation(from: text)
    let titleAndDetail = splitReviewTitleAndDetail(text)

    return ReviewFindingItem(
      id: "",
      original: issue,
      severity: severity,
      title: cleanReviewText(titleAndDetail.title),
      detail: titleAndDetail.detail.map(cleanReviewText),
      location: location.map(cleanReviewText)
    )
  }

  private func splitReviewTitleAndDetail(_ text: String) -> (title: String, detail: String?) {
    let separators = [" \u{2014} ", " -- ", " - "]
    for separator in separators {
      if let range = text.range(of: separator) {
        let title = String(text[..<range.lowerBound])
        let detail = String(text[range.upperBound...])
        return (
          title.trimmingCharacters(in: .whitespacesAndNewlines),
          detail.trimmingCharacters(in: .whitespacesAndNewlines)
        )
      }
    }
    return (text.trimmingCharacters(in: .whitespacesAndNewlines), nil)
  }

  private func extractReviewLocation(from text: String) -> String? {
    let backtickParts = text.split(separator: "`", omittingEmptySubsequences: false)
    for idx in stride(from: 1, to: backtickParts.count, by: 2) {
      let candidate = String(backtickParts[idx])
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if isReviewLocationCandidate(candidate) {
        return trimReviewLocation(candidate)
      }
    }

    for rawWord in text.split(whereSeparator: { $0.isWhitespace }) {
      let candidate = String(rawWord)
        .trimmingCharacters(in: CharacterSet(charactersIn: ".,;()[]`'\""))
      if isReviewLocationCandidate(candidate) {
        return trimReviewLocation(candidate)
      }
    }

    return nil
  }

  private func isReviewLocationCandidate(_ text: String) -> Bool {
    let extensions = [
      ".swift", ".ts", ".tsx", ".js", ".jsx", ".cs", ".css", ".scss", ".html", ".mjs", ".cjs",
    ]
    return extensions.contains { text.contains($0) }
  }

  private func trimReviewLocation(_ text: String) -> String {
    var location = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if let codeStart = location.range(of: ": `") {
      location = String(location[..<codeStart.lowerBound])
    }
    while location.last == ":" || location.last == "." || location.last == "," {
      location.removeLast()
    }
    return location
  }

  private func cleanReviewText(_ text: String) -> String {
    text.replacingOccurrences(of: "`", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  @ViewBuilder
  private func reviewFindingRow(_ item: ReviewFindingItem) -> some View {
    let isDismissed = dismissedFindingIds.contains(item.id)
      || (displayedChecks?.dismissedFindingIds.contains(item.id) ?? false)
    let tint = isDismissed ? Color.green : reviewSeverityTint(item.severity)

    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: isDismissed ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(tint)
          .padding(.top, 2)

        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            if let severity = item.severity {
              Text(severity)
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(tint)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(tint.opacity(0.12), in: Capsule())
            }
            Text(item.title)
              .font(.callout.weight(.semibold))
              .foregroundStyle(isDismissed ? .secondary : .primary)
              .strikethrough(isDismissed)
              .fixedSize(horizontal: false, vertical: true)
          }

          if let detail = item.detail, !detail.isEmpty {
            Text(detail)
              .font(.caption)
              .foregroundStyle(.secondary)
              .strikethrough(isDismissed)
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }

          if let location = item.location, !location.isEmpty {
            Text(location)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.tertiary)
              .lineLimit(1)
              .truncationMode(.middle)
              .textSelection(.enabled)
          }
        }

        Spacer(minLength: 8)

        if isDismissed {
          Text("Dismissed")
            .font(.caption2)
            .foregroundStyle(.secondary)
        } else {
          Button("Dismiss") {
            // Always reset to dismiss when opening — don't leak guidance state from prior use
            overrideAction = "dismiss"; overrideReason = ""; overrideGuidance = ""
            overridePopoverFindingId = item.id
          }
          .font(.caption2)
          .buttonStyle(.bordered)
          .controlSize(.mini)
          .popover(isPresented: Binding(
            get: { overridePopoverFindingId == item.id },
            set: { if !$0 { overridePopoverFindingId = nil } }
          )) {
            overridePopover(findingId: item.id, description: item.original)
          }
        }
      }
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(tint.opacity(0.18), lineWidth: 1))
    .opacity(isDismissed ? 0.65 : 1)
  }

  private func reviewSeverityTint(_ severity: String?) -> Color {
    switch severity?.lowercased() {
    case "critical", "high": .red
    case "medium": .orange
    case "low": .yellow
    default: .red
    }
  }

  @ViewBuilder
  private func preSubmitReviewDisclosure(_ verdict: PreSubmitReviewSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        withAnimation(.easeOut(duration: 0.15)) {
          isPreSubmitExpanded.toggle()
        }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: isPreSubmitExpanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.tertiary)
            .frame(width: 12)
          Image(systemName: preSubmitIcon(for: verdict.status))
            .font(.system(size: 11))
            .foregroundStyle(preSubmitTint(for: verdict.status))
          Text("Agent pre-submit review: \(verdict.status.rawValue) · \(verdict.model)")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
          Spacer()
        }
      }
      .buttonStyle(.plain)

      if isPreSubmitExpanded {
        VStack(alignment: .leading, spacing: 8) {
          if !verdict.reasoning.isEmpty {
            Text(verdict.reasoning)
              .font(.caption)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }

          if !verdict.issues.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
              ForEach(Array(verdict.issues.enumerated()), id: \.offset) { _, issue in
                HStack(alignment: .top, spacing: 6) {
                  Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(preSubmitTint(for: verdict.status))
                    .padding(.top, 2)
                  Text(cleanReviewText(issue))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                }
              }
            }
          }
        }
        .padding(.leading, 18)
      }
    }
    .padding(.top, 2)
  }

  private func preSubmitIcon(for status: PreSubmitReviewSnapshot.Status) -> String {
    switch status {
    case .pass: "checkmark.seal.fill"
    case .fail: "xmark.seal.fill"
    case .uncertain: "questionmark.circle.fill"
    case .skipped: "minus.circle"
    }
  }

  private func preSubmitTint(for status: PreSubmitReviewSnapshot.Status) -> Color {
    switch status {
    case .pass: .green
    case .fail: .red
    case .uncertain: .orange
    case .skipped: .secondary
    }
  }

  @ViewBuilder
  private func phaseStatusRow(status: PhaseStatus, passLabel: String, failLabel: String,
                               skipLabel: String, duration: Int? = nil) -> some View {
    HStack(spacing: 8) {
      Image(systemName: status.icon)
        .font(.system(size: 14))
        .foregroundStyle(status.color)
      VStack(alignment: .leading, spacing: 1) {
        switch status {
        case .passed:    Text(passLabel).font(.callout).foregroundStyle(.green)
        case .failed:    Text(failLabel).font(.callout).foregroundStyle(.red)
        case .skipped:   Text(skipLabel).font(.callout).foregroundStyle(.secondary)
        case .pendingHuman: Text("Pending human decision").font(.callout).foregroundStyle(.orange)
        case .running:   Text("Running…").font(.callout).foregroundStyle(.secondary)
        case .notStarted: Text("Not started").font(.callout).foregroundStyle(.secondary)
        }
        if let dur = duration {
          Text(formatDuration(dur))
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }

  @ViewBuilder
  private func outputBlock(title: String, text: String,
                            expanded: Binding<Bool>, color: Color) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      ScrollView([.vertical, .horizontal], showsIndicators: true) {
        Text(expanded.wrappedValue ? text : tailLines(text))
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(color.opacity(0.9))
          .textSelection(.enabled)
      }
      .frame(maxHeight: expanded.wrappedValue ? .infinity : 300)
      .padding(8)
      .background(Color.black.opacity(0.3))
      .clipShape(RoundedRectangle(cornerRadius: 6))
      outputToggle(expanded: expanded, lineCount: text.split(separator: "\n").count)
    }
  }

  @ViewBuilder
  private func overridePopover(findingId: String, description: String) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Dismiss Finding").font(.headline)
      if showGuidanceOption {
        Picker("Action", selection: $overrideAction) {
          Text("Dismiss").tag("dismiss")
          Text("Give Guidance").tag("guidance")
        }
        .pickerStyle(.segmented)
      }
      if overrideAction == "dismiss" || !showGuidanceOption {
        TextField("Reason (optional)", text: $overrideReason).textFieldStyle(.roundedBorder)
      } else {
        TextField("Guidance for the agent", text: $overrideGuidance, axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .lineLimit(3...6)
      }
      HStack {
        Button("Cancel") { overridePopoverFindingId = nil }
          .buttonStyle(.plain).foregroundStyle(.secondary)
        Spacer()
        Button(overrideConfirmLabel) {
          let fid = findingId; let desc = description
          let action = showGuidanceOption ? overrideAction : "dismiss"
          let reason = overrideReason.isEmpty ? nil : overrideReason
          let guidance = overrideGuidance.isEmpty ? nil : overrideGuidance
          overridePopoverFindingId = nil
          dismissedFindingIds.insert(fid)
          Task { await actions.addValidationOverride(pod.id, fid, desc, action, reason, guidance) }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(overrideAction == "guidance" && overrideGuidance.isEmpty && showGuidanceOption)
      }
    }
    .padding(16)
    .frame(width: 280)
    .onDisappear { overrideAction = "dismiss"; overrideReason = ""; overrideGuidance = "" }
  }

  private func factBadge(_ label: String) -> some View {
    Text(label)
      .font(.system(.caption2, design: .monospaced))
      .padding(.horizontal, 5).padding(.vertical, 2)
      .background(Color.secondary.opacity(0.12))
      .foregroundStyle(.secondary)
      .clipShape(Capsule())
  }

  private func tailLines(_ text: String, count: Int = 100) -> String {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.count > count else { return text }
    return "… (\(lines.count - count) lines truncated)\n" + lines.suffix(count).joined(separator: "\n")
  }

  private func outputToggle(expanded: Binding<Bool>, lineCount: Int) -> some View {
    Group {
      if lineCount > 100 {
        Button(expanded.wrappedValue ? "Show Less" : "Show All (\(lineCount) lines)") {
          expanded.wrappedValue.toggle()
        }
        .font(.caption)
        .foregroundStyle(.blue)
      }
    }
  }

  private func formatDuration(_ ms: Int) -> String {
    if ms < 1000 { return "\(ms)ms" }
    return String(format: "%.1fs", Double(ms) / 1000.0)
  }
}

private struct ReviewFindingItem: Identifiable {
  let id: String
  let original: String
  let severity: String?
  let title: String
  let detail: String?
  let location: String?
}

// MARK: - PhaseChip

private struct PhaseChip: View {
  let phase: ValidationPhase
  let state: ValidationPhaseState
  let isSelected: Bool
  let subLabel: String?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 5) {
        ZStack {
          if state.status == .running {
            ProgressView()
              .controlSize(.small)
              .frame(width: 20, height: 20)
          } else {
            Image(systemName: state.status.icon)
              .font(.system(size: 15, weight: .medium))
              .foregroundStyle(state.status.color)
          }
        }
        .frame(width: 20, height: 20)

        Text(phase.displayName)
          .font(.caption.weight(.medium))
          .foregroundStyle(.primary)

        if let sub = subLabel {
          Text(sub)
            .font(.system(size: 9))
            .foregroundStyle(.secondary)
        } else {
          Text(" ")
            .font(.system(size: 9))
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(minWidth: 76)
      .background(isSelected ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(isSelected ? Color.accentColor.opacity(0.6) : Color.clear, lineWidth: 1.5)
      )
      .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
  }
}

// MARK: - CollapsibleSection

private struct CollapsibleSection<Content: View>: View {
  let title: String
  let icon: String
  var initiallyExpanded: Bool = false
  @ViewBuilder let content: () -> Content
  @State private var isExpanded: Bool?

  private var expanded: Bool { isExpanded ?? initiallyExpanded }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeOut(duration: 0.15)) { isExpanded = !expanded }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: expanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.tertiary)
            .frame(width: 12)
          Image(systemName: icon)
            .font(.system(size: 11))
            .foregroundStyle(.blue)
          Text(title)
            .font(.system(.subheadline).weight(.semibold))
          Spacer()
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .padding(12)

      if expanded {
        Divider().padding(.horizontal, 12)
        VStack(alignment: .leading, spacing: 8) {
          content()
        }
        .padding(12)
      }
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }
}

// MARK: - Previews

#Preview("Validation — passed") {
  ValidationTab(
    pod: MockData.validated,
    checks: ValidationChecks(smoke: true, tests: true, review: true)
  )
  .frame(width: 500, height: 500)
}

#Preview("Validation — failed") {
  ValidationTab(
    pod: MockData.validatedFailed
  )
  .frame(width: 500, height: 700)
}

#Preview("Validation — skipped") {
  ValidationTab(
    pod: MockData.validated,
    checks: ValidationChecks(
      smoke: false, tests: nil, review: nil,
      buildOutput: "error: Module 'foo' not found\nexit code 1"
    )
  )
  .frame(width: 500, height: 500)
}

#Preview("Validation — narrow header") {
  ValidationTab(
    pod: narrowValidationHeaderPreviewPod(),
    actions: .preview,
    loadValidationHistory: { _ in
      try validationHistoryPreviewResponses()
    }
  )
  .frame(width: 500, height: 500)
}

private func narrowValidationHeaderPreviewPod() -> Pod {
  var progress = ValidationProgress.initial(attempt: 2)
  progress.build = ValidationPhaseState(status: .failed, duration: 75_400)
  progress.test = ValidationPhaseState(status: .skipped, duration: 0)
  progress.lint = ValidationPhaseState(status: .passed, duration: 77)
  progress.sast = ValidationPhaseState(status: .skipped, duration: 0)

  return Pod(
    id: "preview-validation-menu",
    status: .validating,
    hasWorktree: true,
    branch: "fix/validation-menu",
    profileName: "webapp",
    model: "claude-sonnet",
    startedAt: Date().addingTimeInterval(-900),
    diffStats: DiffStats(added: 45, removed: 31, files: 6),
    validationProgress: progress,
    containerUrl: URL(string: "http://localhost:3002"),
    attempts: AttemptInfo(current: 2, max: 3)
  )
}

private func validationHistoryPreviewResponses() throws -> [StoredValidationResponse] {
  let json = """
  [
    {
      "id": "validation-attempt-1",
      "podId": "preview-validation-menu",
      "attempt": 1,
      "createdAt": "2026-05-19T10:00:00Z",
      "result": {
        "podId": "preview-validation-menu",
        "attempt": 1,
        "timestamp": "2026-05-19T10:00:00Z",
        "smoke": {
          "status": "fail",
          "build": {
            "status": "fail",
            "output": "Build failed",
            "duration": 75400
          },
          "health": {
            "status": "skip",
            "url": "http://localhost:3000/health",
            "responseCode": null,
            "duration": 0,
            "responseBody": null
          },
          "pages": []
        },
        "overall": "fail",
        "duration": 75477
      }
    }
  ]
  """
  return try JSONDecoder().decode([StoredValidationResponse].self, from: Data(json.utf8))
}
