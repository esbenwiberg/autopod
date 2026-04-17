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
  @State private var isOpeningApp = false
  @State private var isInterrupting = false
  @State private var overridePopoverFindingId: String? = nil
  @State private var overrideAction: String = "dismiss"
  @State private var overrideReason: String = ""
  @State private var overrideGuidance: String = ""

  public init(pod: Pod, checks: ValidationChecks? = nil, actions: PodActions = .preview) {
    self.pod = pod
    self.checks = checks ?? pod.validationChecks
    self.actions = actions
  }

  // MARK: - Derived state

  private var progress: ValidationProgress? { pod.validationProgress }

  /// The phase to show in the detail panel — user pick, then auto-running, else nil.
  private var displayPhase: ValidationPhase? { selectedPhase ?? progress?.activePhase }

  /// Per-phase status, derived from either live progress or the final checks result.
  private func phaseStatus(_ phase: ValidationPhase) -> PhaseStatus {
    if let p = progress { return p.state(for: phase).status }
    guard let c = checks else { return .notStarted }
    switch phase {
    case .build:
      return c.smoke || c.buildOutput == nil ? .passed : .failed
    case .test:
      return switch c.tests { case true: .passed; case false: .failed; default: .skipped }
    case .health:
      if !c.smoke, let h = c.healthCheck { return h.status == "fail" ? .failed : .passed }
      return c.smoke ? .passed : .notStarted
    case .pages:
      if let pages = c.pages { return pages.allSatisfy { $0.status == "pass" } ? .passed : .failed }
      return c.smoke ? .passed : .skipped
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
        Text("Attempt \(attempts.current) of \(attempts.max)")
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
    }
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
      case .health:  healthDetail
      case .pages:   pagesDetail
      case .ac:      acDetail
      case .review:  reviewDetail
      }
    } else if progress == nil && checks == nil {
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
      // AC list always visible at top (regardless of selected phase) for pods with criteria
      if let criteria = pod.acceptanceCriteria, !criteria.isEmpty {
        acListSection(criteria: criteria, acChecks: progress?.acChecks ?? checks?.acChecks)
      }
      // Prompt to click a chip
      Text("Select a phase above to see details")
        .font(.caption)
        .foregroundStyle(.tertiary)
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
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
        outputBlock(title: "Build Output", text: output, expanded: $expandedBuildOutput, color: .red)
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
        outputBlock(title: "Test Output", text: output, expanded: $expandedTestOutput, color: .red)
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
      if let h = health {
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
      screenshotImage(page.screenshotBase64)
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
    }
  }

  @ViewBuilder
  private func acCheckRow(_ check: AcCheckDetail) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
        .font(.system(size: 11))
        .foregroundStyle(check.passed ? .green : .red)
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        Text(check.criterion).font(.callout)
        if let type = check.validationType { triageBadge(type) }
        Text(check.reasoning)
          .font(.caption)
          .foregroundStyle(.secondary)
        screenshotImage(check.screenshot)
      }
    }
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
            let findingId = "review-issue-\(idx)"
            HStack(alignment: .top, spacing: 6) {
              Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 9))
                .foregroundStyle(.red)
                .padding(.top, 2)
              Text(issue).font(.caption)
              Spacer()
              Button("Override") {
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
            screenshotImage(ss)
          }
        }
      }
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
  }

  // MARK: - Shared helpers

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
      ScrollView(.horizontal, showsIndicators: true) {
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
      Text("Override Finding").font(.headline)
      Picker("Action", selection: $overrideAction) {
        Text("Dismiss").tag("dismiss")
        Text("Guidance").tag("guidance")
      }
      .pickerStyle(.segmented)
      if overrideAction == "dismiss" {
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
        Button("Queue Override") {
          let fid = findingId; let desc = description
          let action = overrideAction
          let reason = overrideReason.isEmpty ? nil : overrideReason
          let guidance = overrideGuidance.isEmpty ? nil : overrideGuidance
          overridePopoverFindingId = nil
          Task { await actions.addValidationOverride(pod.id, fid, desc, action, reason, guidance) }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .disabled(overrideAction == "guidance" && overrideGuidance.isEmpty)
      }
    }
    .padding(16)
    .frame(width: 280)
  }

  @ViewBuilder
  private func acListSection(criteria: [String], acChecks: [AcCheckDetail]?) -> some View {
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
            return acChecks.first(where: { $0.criterion == criterion })
                ?? (idx < acChecks.count ? acChecks[idx] : nil)
          }()
          HStack(alignment: .top, spacing: 8) {
            if let result {
              Image(systemName: result.passed ? "checkmark.square.fill" : "xmark.square.fill")
                .font(.system(size: 12))
                .foregroundStyle(result.passed ? .green : .red)
                .padding(.top, 1)
            } else {
              Image(systemName: "square")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .padding(.top, 1)
            }
            VStack(alignment: .leading, spacing: 3) {
              Text(criterion).font(.callout)
              if let type = result?.validationType { triageBadge(type) }
            }
          }
        }
      }
    }
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

  @ViewBuilder
  private func screenshotImage(_ base64: String?) -> some View {
    if let base64, let data = Data(base64Encoded: base64), let nsImage = NSImage(data: data) {
      Image(nsImage: nsImage)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(maxHeight: 300)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
    }
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
