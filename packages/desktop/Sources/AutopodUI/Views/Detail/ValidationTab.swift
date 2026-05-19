import AutopodClient
import SwiftUI

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

  @State private var selectedPhase: ValidationPhase? = nil
  @State private var selectedHistoryKey: String = "current"
  @State private var validationHistory: [StoredValidationResponse] = []
  @State private var isLoadingHistory = false
  @State private var historyError: String?
  @State private var expandedBuildOutput = false
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

  private var progress: ValidationProgress? {
    selectedHistory == nil ? pod.validationProgress : nil
  }

  private var displayedChecks: ValidationChecks? {
    selectedHistory.map { validationChecks(from: $0.result) } ?? checks
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
        loadTime: page.loadTime
      )
    }
    let acValidation: Bool? = response.acValidation.flatMap {
      $0.status == "skip" ? nil : ($0.status == "pass")
    }
    let acChecks = response.acValidation?.results.map { check in
      AcCheckDetail(
        criterion: check.criterion,
        passed: check.passed,
        reasoning: check.reasoning,
        validationType: check.validationType
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

    return ValidationChecks(
      smoke: response.smoke.status == "pass",
      tests: mapTriState(response.test?.status),
      lint: mapTriState(response.lint?.status),
      sast: mapTriState(response.sast?.status),
      review: mapTriState(response.taskReview?.status),
      buildOutput: buildOutput,
      testOutput: testOutput,
      lintOutput: lintOutput,
      sastOutput: sastOutput,
      reviewIssues: response.taskReview?.issues,
      reviewReasoning: response.taskReview?.reasoning,
      reviewSkipReason: response.reviewSkipReason,
      reviewSkipKind: response.reviewSkipKind,
      acSkipReason: response.acSkipReason,
      healthCheck: healthCheck,
      pages: pages,
      acValidation: acValidation,
      acChecks: acChecks,
      factValidation: factValidation,
      factChecks: factChecks,
      requirementsCheck: requirementsCheck
    )
  }

  private func mapTriState(_ status: String?) -> Bool? {
    switch status {
    case "pass": true
    case "fail": false
    default: nil
    }
  }

  private var displayedPhases: [ValidationPhase] {
    [.build, .test, .lint, .sast, .health, .pages, .facts, .review]
  }

  /// The phase to show in the detail panel — user pick, then auto-running, else nil.
  private var displayPhase: ValidationPhase? {
    if let selectedPhase { return selectedPhase }
    let active = progress?.activePhase
    return active == .ac ? nil : active
  }

  /// Combined ordered screenshot set for lightbox navigation: smoke → legacy → review.
  /// Derived from whichever source is live (progress from events, or final checks).
  private var screenshotSet: [ScreenshotRef] {
    let pageShots = (progress?.pageDetails ?? displayedChecks?.pages ?? []).compactMap { $0.screenshot }
    let acShots = (progress?.acChecks ?? displayedChecks?.acChecks ?? []).compactMap { $0.screenshot }
    let reviewShots = progress?.reviewDetail?.screenshots ?? displayedChecks?.taskReviewScreenshots ?? []
    return pageShots + acShots + reviewShots
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
    case .build:
      return c.smoke || c.buildOutput == nil ? .passed : .failed
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
    case .ac:
      return switch c.acValidation { case true: .passed; case false: .failed; default: .skipped }
    case .facts:
      return switch c.factValidation { case true: .passed; case false: .failed; default: .skipped }
    case .review:
      return switch c.review { case true: .passed; case false: .failed; default: .skipped }
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
      case .ac:
        let count = p.acTotalCount
        if p.ac.status == .running { return "running…" }
        return count > 0 ? "\(count) legacy" : nil
      case .facts:
        let count = p.factTotalCount
        if p.facts.status == .running { return "running…" }
        return count > 0 ? "\(count) facts" : nil
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
      case .ac:
        return c.acChecks.map { "\($0.count) legacy" }
      case .facts:
        return c.factChecks.map { "\($0.count) facts" }
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
      if let attempts = pod.attempts {
        Text(attempts.reworkCount > 0 ? "Rework \(attempts.reworkCount) — Attempt \(attempts.current) of \(attempts.max)" : "Attempt \(attempts.current) of \(attempts.max)")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else if let p = progress {
        Text("Attempt \(p.attempt)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if pod.fixIteration > 0 {
        Text("Fix iteration \(pod.fixIteration)")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.indigo)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(.indigo.opacity(0.12), in: Capsule())
      }
      validationHistoryMenu
      Spacer()
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
              Text("Starting…")
            }
          } else {
            Label("Open App", systemImage: "safari")
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
            HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Updating…") }
          } else if pod.skipValidation {
            Label("Skipping", systemImage: "forward.fill")
          } else {
            Label("Skip Validation", systemImage: "forward")
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
            HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Updating…") }
          } else {
            Label("Update From Base", systemImage: "arrow.triangle.2.circlepath")
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
            HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Stopping…") }
          } else {
            Label("Interrupt", systemImage: "stop.fill")
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
            HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Approving…") }
          } else {
            Label("Force Approve", systemImage: "checkmark.seal.fill")
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
    if let message = updateFromBaseMessage {
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private var validationHistoryMenu: some View {
    if isLoadingHistory {
      ProgressView()
        .controlSize(.mini)
        .help("Loading validation history")
    } else if !sortedValidationHistory.isEmpty {
      Picker("Validation attempt", selection: $selectedHistoryKey) {
        Text("Current").tag("current")
        ForEach(sortedValidationHistory) { item in
          Text("Attempt \(item.attempt) · \(item.result.overall)")
            .tag(String(item.attempt))
        }
      }
      .pickerStyle(.menu)
      .controlSize(.small)
      .frame(maxWidth: 150)
      .help("Show current or previous validation results")
    } else if let historyError {
      Image(systemName: "clock.badge.exclamationmark")
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .help(historyError)
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
    if let failed = displayedPhases.first(where: { phaseStatus($0) == .failed }) {
      return "\(failed.displayName) needs attention"
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
    if let failed = displayedPhases.first(where: { phaseStatus($0) == .failed }) {
      return [failed.displayName + " failed.", contractSummary].compactMap { $0 }.joined(separator: " ")
    }
    if let active = progress?.activePhase {
      return [active.displayName + " is currently running.", contractSummary].compactMap { $0 }.joined(separator: " ")
    }
    return contractSummary ?? "Build, checks, facts, and review results are shown below."
  }

  private var validationSummaryIcon: String {
    if displayedPhases.contains(where: { phaseStatus($0) == .failed }) { return "xmark.seal.fill" }
    if displayedPhases.contains(where: { phaseStatus($0) == .running }) { return "arrow.triangle.2.circlepath" }
    if displayedChecks?.allPassed == true { return "checkmark.seal.fill" }
    return "checkmark.seal"
  }

  private var validationSummaryColor: Color {
    if displayedPhases.contains(where: { phaseStatus($0) == .failed }) { return .red }
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
      case .build:   buildDetail
      case .test:    testDetail
      case .lint:    lintDetail
      case .sast:    sastDetail
      case .health:  healthDetail
      case .pages:   pagesDetail
      case .ac:      acDetail
      case .facts:   factsDetail
      case .review:  reviewDetail
      }
    } else {
      let criteria = pod.acceptanceCriteria ?? []
      // Legacy criteria list stays visible when older pods have criteria,
      // regardless of validation state.
      if !criteria.isEmpty {
        acListSection(criteria: criteria, acChecks: progress?.acChecks ?? displayedChecks?.acChecks)
      }
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
        .padding(.top, criteria.isEmpty ? 40 : 16)
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

  @ViewBuilder
  private var buildDetail: some View {
    let status = phaseStatus(.build)
    let output: String? = progress?.buildOutput ?? displayedChecks?.buildOutput
    let dur: Int? = progress?.build.duration

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Build succeeded", failLabel: "Build failed",
                     skipLabel: "Build skipped", duration: dur)
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
    let smokeOk = displayedChecks?.smoke ?? (progress?.build.status == .passed)

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "All tests passed", failLabel: "Tests failed",
                     skipLabel: smokeOk ? "No test command configured" : "Build failed — tests skipped",
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
    let buildOk = displayedChecks?.smoke != false || (progress?.build.status == .passed)

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Lint passed", failLabel: "Lint failed",
                     skipLabel: buildOk ? "No lint command configured" : "Build failed — lint skipped",
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
    let buildOk = displayedChecks?.smoke != false || (progress?.build.status == .passed)

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Security scan passed", failLabel: "Security scan failed",
                     skipLabel: buildOk ? "No SAST command configured" : "Build failed — SAST skipped",
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
      if let ref = page.screenshot {
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
  private var acDetail: some View {
    let status = phaseStatus(.ac)
    let acChecks: [AcCheckDetail]? = progress?.acChecks ?? displayedChecks?.acChecks
    let criteria = pod.acceptanceCriteria

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "Legacy checks verified",
                     failLabel: "Legacy checks failed",
                     skipLabel: acSkipLabel(reason: displayedChecks?.acSkipReason))
      if let criteria, !criteria.isEmpty {
        acListSection(criteria: criteria, acChecks: acChecks)
      } else if let acChecks, !acChecks.isEmpty {
        // No explicit criteria list — show from results
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(acChecks.enumerated()), id: \.offset) { _, check in
            acCheckRow(check)
          }
        }
      }
      correctionMessageBlock
    }
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
              scenarioCard(scenario)
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
  private func scenarioCard(_ scenario: ContractScenarioResponse) -> some View {
    VStack(alignment: .leading, spacing: 8) {
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

      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 10) {
          scenarioColumn("Given", scenario.given)
          scenarioColumn("When", scenario.when)
          scenarioColumn("Then", scenario.then)
        }

        VStack(alignment: .leading, spacing: 10) {
          scenarioColumn("Given", scenario.given)
          scenarioColumn("When", scenario.when)
          scenarioColumn("Then", scenario.then)
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.blue.opacity(0.12), lineWidth: 1))
  }

  @ViewBuilder
  private func scenarioColumn(_ label: String, _ lines: [String]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label.uppercased())
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.secondary)
        .tracking(0.4)
      ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
        HStack(alignment: .top, spacing: 6) {
          Circle()
            .fill(Color.secondary.opacity(0.45))
            .frame(width: 4, height: 4)
            .padding(.top, 6)
          Text(line)
            .font(.caption)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .background(Color(nsColor: .windowBackgroundColor).opacity(0.55))
    .clipShape(RoundedRectangle(cornerRadius: 6))
  }

  @ViewBuilder
  private func requiredFactCard(_ fact: RequiredFactResponse, evidence: FactCheckDetail?) -> some View {
    let evidenceColor: Color = evidence == nil ? .secondary : (evidence?.passed == true ? .green : .red)
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(evidenceColor.opacity(evidence == nil ? 0.35 : 0.75))
        .frame(width: 3)

      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: evidence == nil ? "clock" : (evidence?.passed == true ? "checkmark.circle.fill" : "xmark.circle.fill"))
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(evidenceColor)
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
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(evidenceColor.opacity(0.15), lineWidth: 1))
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
    let label = evidence == nil ? "awaiting evidence" : (evidence?.passed == true ? "passed" : "failed")
    let color: Color = evidence == nil ? .secondary : (evidence?.passed == true ? .green : .red)
    return Text(label)
      .font(.system(.caption2, design: .monospaced).weight(.semibold))
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(color.opacity(0.12), in: Capsule())
      .foregroundStyle(color)
  }

  @ViewBuilder
  private func factEvidenceCard(_ check: FactCheckDetail) -> some View {
    let statusColor: Color = check.passed ? .green : .red
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(statusColor.opacity(0.7))
        .frame(width: 3)
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
            .font(.system(size: 13))
            .foregroundStyle(statusColor)
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
          factBadge("evidence")
        }
        factEvidenceBody(check)
      }
      .padding(10)
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(statusColor.opacity(0.15), lineWidth: 1))
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
    if let stderr = check.stderr, !stderr.isEmpty {
      outputBlock(title: "Fact Error Output", text: stderr, expanded: .constant(false), color: .red)
    }
  }

  @ViewBuilder
  private func acCheckRow(_ check: AcCheckDetail) -> some View {
    let statusColor: Color = check.passed ? .green : .red
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(statusColor.opacity(0.7))
        .frame(width: 3)
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
            .font(.system(size: 13))
            .foregroundStyle(check.passed ? .green : .red)
            .padding(.top, 1)
          Text(check.criterion)
            .font(.callout.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 4)
          if let type = check.validationType { triageBadge(type) }
        }
        if !check.reasoning.isEmpty {
          Text(check.reasoning)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor).opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        if let ref = check.screenshot {
          ScreenshotThumbnail(ref: ref, allRefs: screenshotSet, onOpen: { openLightbox($0) })
        }
      }
      .padding(10)
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(statusColor.opacity(0.15), lineWidth: 1))
  }

  @ViewBuilder
  private func acCriterionCard(criterion: AcDefinition, result: AcCheckDetail?, index _: Int) -> some View {
    let firing = acIsFiring(criterion, result)
    let statusColor: Color = firing
      ? (result.map { $0.passed ? .green : .red } ?? Color.secondary)
      : Color.secondary
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(statusColor.opacity(0.7))
        .frame(width: 3)
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          if !firing {
            Image(systemName: "minus.circle")
              .font(.system(size: 13))
              .foregroundStyle(Color.secondary)
              .padding(.top, 1)
          } else if let result {
            Image(systemName: result.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
              .font(.system(size: 13))
              .foregroundStyle(result.passed ? .green : .red)
              .padding(.top, 1)
          } else {
            Image(systemName: "circle.dashed")
              .font(.system(size: 13))
              .foregroundStyle(Color.secondary)
              .padding(.top, 1)
          }
          VStack(alignment: .leading, spacing: 2) {
            Text(criterion.outcome)
              .font(.callout.weight(.medium))
              .foregroundStyle(firing ? .primary : .secondary)
              .fixedSize(horizontal: false, vertical: true)
            if let hint = criterion.hint, !hint.isEmpty {
              Text(hint)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Spacer(minLength: 4)
          HStack(spacing: 4) {
            if !firing { decorativeAcBadge() }
            if criterion.type != .none { acTypeBadge(criterion.type) }
            if let type = result?.validationType { triageBadge(type) }
          }
        }
        if let reasoning = result?.reasoning, !reasoning.isEmpty {
          Text(reasoning)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor).opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        if let ref = result?.screenshot {
          ScreenshotThumbnail(ref: ref, allRefs: screenshotSet, onOpen: { openLightbox($0) })
        }
      }
      .padding(10)
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(statusColor.opacity(0.15), lineWidth: 1))
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

  /// Label for the legacy criteria chip when status is .skipped, derived from the backend's
  /// machine-readable `acSkipReason` so the UI can distinguish "tier-1 failed"
  /// from "no criteria configured" instead of showing a generic message.
  private func acSkipLabel(reason: String?) -> String {
    switch reason {
    case "upstream-failed": return "Skipped — earlier validation phases failed"
    case "profile-skip": return "Legacy criteria validation disabled by profile"
    case "health-failed": return "Skipped — health check failed"
    case "no-criteria": return "No legacy criteria configured"
    default: return "Legacy criteria validation skipped"
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

  @ViewBuilder
  private func acListSection(criteria: [AcDefinition], acChecks: [AcCheckDetail]?) -> some View {
    let firing = firingCount(criteria, acChecks)
    let total = criteria.count
    let title: String = total == 0
      ? "Legacy Criteria (0)"
      : (firing == total
          ? "Legacy Criteria (\(total))"
          : "Legacy Criteria (\(firing) firing / \(total))")
    CollapsibleSection(
      title: title,
      icon: "checklist",
      initiallyExpanded: acChecks?.contains(where: { !$0.passed }) == true
    ) {
      VStack(alignment: .leading, spacing: 6) {
        if let source = pod.acFrom {
          HStack(spacing: 3) {
            Image(systemName: "doc.text").font(.system(size: 9))
            Text(source).font(.system(.caption2, design: .monospaced))
          }
          .foregroundStyle(.tertiary)
        }
        if total > 0 && firing == 0 {
          HStack(alignment: .top, spacing: 6) {
            Image(systemName: "info.circle").font(.system(size: 10))
            Text("No firing legacy checks — every criterion is `none` (build/test/grep commands and undeclared types are no-ops). Pass/fail falls back to required facts, the diff reviewer, and pipeline build/test.")
              .font(.caption2)
              .fixedSize(horizontal: false, vertical: true)
          }
          .foregroundStyle(.secondary)
          .padding(.bottom, 4)
        }
        ForEach(Array(criteria.enumerated()), id: \.offset) { idx, criterion in
          let result: AcCheckDetail? = {
            guard let acChecks else { return nil }
            return acChecks.first(where: { $0.criterion == criterion.outcome })
                ?? (idx < acChecks.count ? acChecks[idx] : nil)
          }()
          acCriterionCard(criterion: criterion, result: result, index: idx)
        }
      }
    }
  }

  /// True when this legacy criterion actually gates pass/fail in the validation engine.
  /// Mirrors `local-validation-engine.ts` — `api`, `web`, and `cmd` types fire.
  /// Any criterion classified to `none` post-execution is decorative (the
  /// banlist demotes shell-command criteria that look like build/test/lint to none).
  private func acIsFiring(_ criterion: AcDefinition, _ result: AcCheckDetail?) -> Bool {
    if let v = result?.validationType {
      return v == "api" || v == "web-ui" || v == "cmd"
    }
    if criterion.type == .cmd, isCommandLikeAcText(criterion.outcome) { return false }
    return criterion.type == .api || criterion.type == .web || criterion.type == .cmd
  }

  private func firingCount(_ criteria: [AcDefinition], _ checks: [AcCheckDetail]?) -> Int {
    criteria.enumerated().reduce(0) { acc, pair in
      let (idx, c) = pair
      let result: AcCheckDetail? = {
        guard let checks else { return nil }
        return checks.first(where: { $0.criterion == c.outcome })
            ?? (idx < checks.count ? checks[idx] : nil)
      }()
      return acc + (acIsFiring(c, result) ? 1 : 0)
    }
  }

  /// Mirrors the tightened slash-command regex in
  /// `packages/daemon/src/validation/local-validation-engine.ts` (ADR-024) so
  /// the desktop can pre-classify shell-command-only ACs as decorative before
  /// the engine runs. Only fires for single-token `/<lowercase>` outcomes —
  /// declared web ACs with `/pr-dashboard ...` prose are trusted.
  private func isCommandLikeAcText(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return false }
    return t.range(of: #"^/[a-z][a-z0-9-]*\s*$"#, options: .regularExpression) != nil
  }

  private func acTypeBadge(_ type: AcDefinition.AcType) -> some View {
    let color: Color = switch type {
    case .web: .blue
    case .api: .orange
    case .cmd: .purple
    case .none: .secondary
    }
    return Text(type.label.lowercased())
      .font(.system(.caption2, design: .monospaced))
      .padding(.horizontal, 5).padding(.vertical, 2)
      .background(color.opacity(0.12))
      .foregroundStyle(color)
      .clipShape(Capsule())
  }

  private func decorativeAcBadge() -> some View {
    Text("decorative")
      .font(.system(.caption2, design: .monospaced))
      .padding(.horizontal, 5).padding(.vertical, 2)
      .background(Color.secondary.opacity(0.12))
      .foregroundStyle(Color.secondary)
      .clipShape(Capsule())
      .help("Not gated by the validation engine — pass/fail falls back to the diff reviewer.")
  }

  private func triageBadge(_ type: String) -> some View {
    let (label, color): (String, Color) = switch type {
    case "web-ui": ("web-ui", .blue)
    case "api":    ("api",    .orange)
    case "cmd":    ("cmd",    .purple)
    default:       ("none",   Color.secondary)
    }
    return Text(label)
      .font(.system(.caption2, design: .monospaced))
      .padding(.horizontal, 5).padding(.vertical, 2)
      .background(color.opacity(0.12))
      .foregroundStyle(color)
      .clipShape(Capsule())
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
