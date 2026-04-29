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

  @State private var selectedPhase: ValidationPhase? = nil
  @State private var expandedBuildOutput = false
  @State private var expandedTestOutput = false
  @State private var expandedLintOutput = false
  @State private var expandedSastOutput = false
  @State private var isOpeningApp = false
  @State private var isInterrupting = false
  @State private var isSkippingValidation = false
  @State private var isForceApproving = false
  @State private var showForceApprovePopover = false
  @State private var forceApproveReason: String = ""
  @State private var overridePopoverFindingId: String? = nil
  @State private var overrideAction: String = "dismiss"
  @State private var overrideReason: String = ""
  @State private var overrideGuidance: String = ""
  @State private var dismissedFindingIds: Set<String> = []

  public init(pod: Pod, checks: ValidationChecks? = nil, actions: PodActions = .preview) {
    self.pod = pod
    self.checks = checks ?? pod.validationChecks
    self.actions = actions
  }

  // MARK: - Derived state

  private var progress: ValidationProgress? { pod.validationProgress }

  /// The phase to show in the detail panel — user pick, then auto-running, else nil.
  private var displayPhase: ValidationPhase? { selectedPhase ?? progress?.activePhase }

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
    guard let c = checks else { return .notStarted }
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
        return count > 0 ? "\(count) criteria" : nil
      default:
        if let dur = p.state(for: phase).duration {
          return formatDuration(dur)
        }
        return nil
      }
    }
    // Fallback from checks
    if let c = checks {
      switch phase {
      case .pages:
        return c.pages.map { "\($0.count) pages" }
      case .ac:
        return c.acChecks.map { "\($0.count) criteria" }
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
          phaseDetailPanel
        }
        .padding(20)
      }
    }
    .onChange(of: progress?.attempt) { _, _ in
      // Reset user selection when a new validation attempt starts
      selectedPhase = nil
    }
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
    let hasAnyData = progress != nil || checks != nil
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(ValidationPhase.allCases, id: \.self) { phase in
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
      case .review:  reviewDetail
      }
    } else {
      let criteria = pod.acceptanceCriteria ?? []
      // AC list always visible when pod has criteria, regardless of validation state
      if !criteria.isEmpty {
        acListSection(criteria: criteria, acChecks: progress?.acChecks ?? checks?.acChecks)
      }
      if progress == nil && checks == nil {
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
    let output: String? = progress?.buildOutput ?? checks?.buildOutput
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
    let output: String? = progress?.testOutput ?? checks?.testOutput
    let dur: Int? = progress?.test.duration
    let smokeOk = checks?.smoke ?? (progress?.build.status == .passed)

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
    let output: String? = progress?.lintOutput ?? checks?.lintOutput
    let dur: Int? = progress?.lint.duration
    let buildOk = checks?.smoke != false || (progress?.build.status == .passed)

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
    let output: String? = progress?.sastOutput ?? checks?.sastOutput
    let dur: Int? = progress?.sast.duration
    let buildOk = checks?.smoke != false || (progress?.build.status == .passed)

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
    let health: HealthCheckDetail? = progress?.healthDetail ?? checks?.healthCheck
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
    let pages: [PageDetail]? = progress?.pageDetails ?? checks?.pages

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
      screenshotThumbnail(page.screenshotBase64)
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
    let acChecks: [AcCheckDetail]? = progress?.acChecks ?? checks?.acChecks
    let criteria = pod.acceptanceCriteria

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(status: status, passLabel: "All criteria verified",
                     failLabel: "Some criteria failed", skipLabel: "AC validation skipped")
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
        screenshotThumbnail(check.screenshot)
      }
      .padding(10)
    }
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(statusColor.opacity(0.15), lineWidth: 1))
  }

  @ViewBuilder
  private func acCriterionCard(criterion: AcDefinition, result: AcCheckDetail?, index _: Int) -> some View {
    let statusColor: Color = result.map { $0.passed ? .green : .red } ?? Color.secondary
    HStack(alignment: .top, spacing: 0) {
      Rectangle()
        .fill(statusColor.opacity(0.7))
        .frame(width: 3)
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          if let result {
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
          Text(criterion.test)
            .font(.callout.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 4)
          HStack(spacing: 4) {
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
        screenshotThumbnail(result?.screenshot)
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
    let issues: [String] = detail?.issues ?? checks?.reviewIssues ?? []
    let reasoning: String? = detail?.reasoning ?? checks?.reviewReasoning
    let skipReason: String? = checks?.reviewSkipReason
    let reqs: [RequirementCheckDetail]? = detail?.requirementsCheck ?? checks?.requirementsCheck
    let screenshots: [String] = detail?.screenshots ?? checks?.taskReviewScreenshots ?? []

    VStack(alignment: .leading, spacing: 12) {
      phaseStatusRow(
        status: status,
        passLabel: detail?.status == "uncertain" ? "Review uncertain — treated as pass" : "AI review passed",
        failLabel: "Review flagged issues",
        skipLabel: skipReason ?? "Review skipped"
      )
      if let reasoning, !reasoning.isEmpty {
        Text(reasoning)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if !issues.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("Issues")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          ForEach(Array(issues.enumerated()), id: \.offset) { idx, issue in
            let findingId = checks?.reviewFindings?.first(where: { $0.description == issue })?.id
              ?? "review-issue-\(idx)"
            let isDismissed = dismissedFindingIds.contains(findingId)
              || (checks?.dismissedFindingIds.contains(findingId) ?? false)
            HStack(alignment: .top, spacing: 6) {
              Image(systemName: isDismissed ? "checkmark.circle.fill" : "exclamationmark.triangle")
                .font(.system(size: 9))
                .foregroundStyle(isDismissed ? .green : .red)
                .padding(.top, 2)
              Text(issue)
                .font(.caption)
                .foregroundStyle(isDismissed ? .secondary : .primary)
                .strikethrough(isDismissed)
              Spacer()
              if isDismissed {
                Text("Dismissed")
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              } else {
                Button("Dismiss") {
                  // Always reset to dismiss when opening — don't leak guidance state from prior use
                  overrideAction = "dismiss"; overrideReason = ""; overrideGuidance = ""
                  overridePopoverFindingId = findingId
                }
                .font(.caption2)
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .popover(isPresented: Binding(
                  get: { overridePopoverFindingId == findingId },
                  set: { if !$0 { overridePopoverFindingId = nil } }
                )) {
                  overridePopover(findingId: findingId, description: issue)
                }
              }
            }
            .opacity(isDismissed ? 0.6 : 1)
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
          ForEach(Array(screenshots.enumerated()), id: \.offset) { _, ss in
            screenshotThumbnail(ss)
          }
        }
      }
      correctionMessageBlock
    }
  }

  // MARK: - Shared helpers

  @ViewBuilder
  private var correctionMessageBlock: some View {
    if let msg = checks?.correctionMessage {
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
    CollapsibleSection(
      title: "Acceptance Criteria (\(criteria.count))",
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
        ForEach(Array(criteria.enumerated()), id: \.offset) { idx, criterion in
          let result: AcCheckDetail? = {
            guard let acChecks else { return nil }
            return acChecks.first(where: { $0.criterion == criterion.test })
                ?? (idx < acChecks.count ? acChecks[idx] : nil)
          }()
          acCriterionCard(criterion: criterion, result: result, index: idx)
        }
      }
    }
  }

  private func acTypeBadge(_ type: AcDefinition.AcType) -> some View {
    let color: Color = switch type {
    case .web: .blue
    case .api: .orange
    case .none: .secondary
    }
    return Text(type.label.lowercased())
      .font(.system(.caption2, design: .monospaced))
      .padding(.horizontal, 5).padding(.vertical, 2)
      .background(color.opacity(0.12))
      .foregroundStyle(color)
      .clipShape(Capsule())
  }

  private func triageBadge(_ type: String) -> some View {
    let (label, color): (String, Color) = switch type {
    case "web-ui": ("web-ui", .blue)
    case "api":    ("api",    .orange)
    default:       ("none",   Color.secondary)
    }
    return Text(label)
      .font(.system(.caption2, design: .monospaced))
      .padding(.horizontal, 5).padding(.vertical, 2)
      .background(color.opacity(0.12))
      .foregroundStyle(color)
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
