import Foundation
import AutopodClient
import AutopodUI

/// Maps daemon API response types to AutopodUI display models.
public enum PodMapper {

  nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

  nonisolated(unsafe) private static let isoFormatterNoFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()

  static func parseDate(_ string: String?) -> Date {
    guard let string else { return Date() }
    return isoFormatter.date(from: string)
        ?? isoFormatterNoFraction.date(from: string)
        ?? Date()
  }

  // MARK: - Screenshot ref mapping

  /// Maps a `ScreenshotRefResponse` DTO to the UI model `ScreenshotRef`.
  /// Returns nil when `dto` is nil or `baseURL` is nil or the source string is unrecognised.
  static func mapScreenshotRef(
    _ dto: ScreenshotRefResponse?,
    baseURL: URL?
  ) -> ScreenshotRef? {
    guard let dto, let baseURL else { return nil }
    guard let source = ScreenshotRef.Source(rawValue: dto.source) else { return nil }
    guard let url = URL(string: dto.url, relativeTo: baseURL)?.absoluteURL else { return nil }
    return ScreenshotRef(url: url, source: source, label: dto.path)
  }

  // MARK: - SessionResponse → Pod

  public static func map(_ response: SessionResponse, baseURL: URL? = nil) -> Pod {
    let status = PodStatus(rawValue: response.status) ?? .queued
    // The daemon always ships PodOptions under `options` on the wire (Pod.options is
    // non-optional in shared). If it's missing, we're talking to an incompatible
    // daemon — don't silently coerce via the lossy legacy outputMode path, which
    // collapses {interactive, artifact} → {interactive, branch} and has caused
    // real user-visible bugs (wrong badge, missing Markdown tab). Log + default
    // instead, so the failure mode is a stale UI rather than silently-wrong state.
    let pod: PodConfig = {
      if let p = response.pod {
        let agent = AgentMode(rawValue: p.agentMode) ?? .auto
        let output = OutputTarget(rawValue: p.output) ?? .pr
        return PodConfig(agentMode: agent, output: output, validate: p.validate, promotable: p.promotable)
      }
      print("[PodMapper] WARNING: pod \(response.id) response missing `options` — daemon/client version skew?")
      return PodConfig()
    }()

    // Map escalation from pending escalation
    let escalationQuestion: String? = {
      guard let esc = response.pendingEscalation, esc.response == nil else { return nil }
      if esc.type == "action_approval", let actionName = esc.payload.actionName {
        // Include params so the reviewer sees which resource is being accessed
        if let params = esc.payload.params, !params.isEmpty {
          let details = params.sorted(by: { $0.key < $1.key })
            .map { "\($0.key): \($0.value.displayValue)" }
            .joined(separator: ", ")
          return "Approve action: \(actionName) (\(details))"
        }
        return "Approve action: \(actionName)"
      }
      // validation_override: payload has findings/attempt/maxAttempts but no
      // question/description — synthesise one so the input card renders. Without
      // this the pod sits in awaiting_input with no UI to respond.
      if esc.type == "validation_override" {
        let findings = esc.payload.findings ?? []
        let header: String = {
          if let attempt = esc.payload.attempt, let max = esc.payload.maxAttempts {
            return "Validation found \(findings.count) recurring finding(s) after \(attempt)/\(max) attempts."
          }
          return "Validation found \(findings.count) recurring finding(s)."
        }()
        let body = findings.isEmpty
          ? ""
          : "\n\n" + findings.enumerated()
              .map { "\($0.offset + 1). \($0.element.description)" }
              .joined(separator: "\n")
        let hint = "\n\nReply `dismiss` to override all, `dismiss 1,3` for specific items, or any other text as guidance for the agent."
        return header + body + hint
      }
      if esc.type == "request_credential" {
        if let reason = esc.payload.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
           !reason.isEmpty {
          return reason
        }
        let service = switch esc.payload.service {
        case "github": "GitHub"
        case "ado": "ADO"
        default: "git provider"
        }
        return "Credential update required for \(service). Update the profile PAT, then reply to retry."
      }
      return esc.payload.question ?? esc.payload.description
    }()
    let escalationOptions: [String]? = {
      guard let esc = response.pendingEscalation, esc.response == nil else { return nil }
      guard let opts = esc.payload.options, !opts.isEmpty else { return nil }
      return opts
    }()
    let escalationType: String? = {
      guard let esc = response.pendingEscalation, esc.response == nil else { return nil }
      return esc.type
    }()

    // Map validation checks from last validation result
    let validationChecks: ValidationChecks? = {
      guard let v = response.lastValidationResult else { return nil }
      let buildOutput = v.smoke.build.status == "fail" && !v.smoke.build.output.isEmpty
        ? v.smoke.build.output : nil
      let testOutput: String? = {
        guard let t = v.test, t.status != "pass" else { return nil }
        let combined = [t.stdout, t.stderr].compactMap { $0 }.joined(separator: "\n")
        return combined.isEmpty ? nil : combined
      }()
      let lintOutput: String? = v.lint?.status == "fail" ? (v.lint?.output.isEmpty == false ? v.lint?.output : nil) : nil
      let sastOutput: String? = v.sast?.status == "fail" ? (v.sast?.output.isEmpty == false ? v.sast?.output : nil) : nil
      let healthCheck = HealthCheckDetail(
        status: v.smoke.health.status,
        url: v.smoke.health.url,
        responseCode: v.smoke.health.responseCode,
        duration: v.smoke.health.duration,
        responseBody: v.smoke.health.responseBody
      )
      let pages: [PageDetail]? = v.smoke.pages.isEmpty ? nil : v.smoke.pages.map { p in
        PageDetail(
          path: p.path,
          status: p.status,
          consoleErrors: p.consoleErrors,
          assertions: p.assertions.map { a in
            AssertionDetail(selector: a.selector, type: a.type, expected: a.expected, actual: a.actual, passed: a.passed)
          },
          loadTime: p.loadTime,
          screenshot: mapScreenshotRef(p.screenshot, baseURL: baseURL)
        )
      }
      let acValidation: Bool? = v.acValidation.flatMap { $0.status == "skip" ? nil : ($0.status == "pass") }
      let acChecks: [AcCheckDetail]? = v.acValidation?.results.map { r in
        AcCheckDetail(
          criterion: r.criterion, passed: r.passed, reasoning: r.reasoning,
          screenshot: mapScreenshotRef(r.screenshot, baseURL: baseURL),
          validationType: r.validationType
        )
      }
      let factValidation: Bool? = v.factValidation.flatMap { $0.status == "skip" ? nil : ($0.status == "pass") }
      let factChecks: [FactCheckDetail]? = v.factValidation?.results.map { r in
        FactCheckDetail(
          factId: r.factId, proves: r.proves, kind: r.kind, artifactPath: r.artifactPath,
          command: r.command, passed: r.passed, status: r.status, exitCode: r.exitCode,
          durationMs: r.durationMs, artifact: r.artifact, attachments: r.attachments,
          reasoning: r.reasoning,
          stdout: r.stdout, stderr: r.stderr
        )
      }
      let requirementsCheck: [RequirementCheckDetail]? = v.taskReview?.requirementsCheck?.map { r in
        RequirementCheckDetail(criterion: r.criterion, met: r.met, note: r.note)
      }
      let taskReviewScreenshots: [ScreenshotRef]? = {
        guard let ss = v.taskReview?.screenshots, !ss.isEmpty else { return nil }
        let refs = ss.compactMap { mapScreenshotRef($0, baseURL: baseURL) }
        return refs.isEmpty ? nil : refs
      }()
      let proofOfWorkScreenshots: [ScreenshotRef]? = {
        let shots = v.smoke.pages.compactMap { p in
          mapScreenshotRef(p.screenshot, baseURL: baseURL)
        }
        return shots.isEmpty ? nil : shots
      }()
      let dismissedFindingIds = Set(
        (response.validationOverrides ?? [])
          .filter { $0.action == "dismiss" }
          .map { $0.findingId }
      )
      return ValidationChecks(
        smoke: v.smoke.status == "pass",
        tests: mapTriState(v.test?.status),
        lint: mapTriState(v.lint?.status),
        sast: mapTriState(v.sast?.status),
        review: mapTriState(v.taskReview?.status),
        buildOutput: buildOutput,
        testOutput: testOutput,
        lintOutput: lintOutput,
        sastOutput: sastOutput,
        reviewIssues: v.taskReview?.issues,
        reviewFindings: response.lastValidationFindings,
        dismissedFindingIds: dismissedFindingIds,
        reviewReasoning: v.taskReview?.reasoning,
        reviewSkipReason: v.reviewSkipReason,
        reviewSkipKind: v.reviewSkipKind,
        acSkipReason: v.acSkipReason,
        healthCheck: healthCheck,
        pages: pages,
        acValidation: acValidation,
        acChecks: acChecks,
        factValidation: factValidation,
        factChecks: factChecks,
        requirementsCheck: requirementsCheck,
        taskReviewScreenshots: taskReviewScreenshots,
        proofOfWorkScreenshots: proofOfWorkScreenshots,
        correctionMessage: response.lastCorrectionMessage
      )
    }()

    // Map diff stats
    let diffStats: DiffStats? = {
      guard response.filesChanged > 0 || response.linesAdded > 0 || response.linesRemoved > 0
      else { return nil }
      return DiffStats(
        added: response.linesAdded,
        removed: response.linesRemoved,
        files: response.filesChanged
      )
    }()

    // Map plan
    let plan: SessionPlan? = {
      guard let p = response.plan else { return nil }
      return SessionPlan(summary: p.summary, steps: p.steps)
    }()

    // Map phase progress
    let phase: PhaseProgress? = {
      guard let p = response.progress else { return nil }
      return PhaseProgress(
        current: p.currentPhase,
        total: p.totalPhases,
        description: p.description
      )
    }()

    // Map attempt info
    let attempts: AttemptInfo? = {
      let rework = response.reworkCount ?? 0
      guard response.validationAttempts > 0 || rework > 0 else { return nil }
      return AttemptInfo(
        current: response.validationAttempts,
        max: response.maxValidationAttempts,
        reworkCount: rework
      )
    }()

    // Map task summary
    let taskSummary: TaskSummary? = {
      guard let ts = response.taskSummary else { return nil }
      return TaskSummary(
        actualSummary: ts.actualSummary,
        deviations: ts.deviations.map {
          DeviationItem(step: $0.step, planned: $0.planned, actual: $0.actual, reason: $0.reason)
        },
        factEvidence: ts.factEvidence
      )
    }()

    // Error summary for failed pods
    let errorSummary: String? = {
      guard status == .failed || status == .killed || status == .reviewRequired else { return nil }
      // Try to extract from last validation
      if let issues = response.lastValidationResult?.taskReview?.issues, !issues.isEmpty {
        return issues.first
      }
      if let smoke = response.lastValidationResult?.smoke, smoke.status == "fail" {
        if smoke.build.status == "fail" {
          return "Build failed"
        }
        if smoke.health.status == "fail" {
          return "Health check failed"
        }
      }
      return nil
    }()

    let prUrl: URL? = response.prUrl.flatMap { URL(string: $0) }
    let containerUrl: URL? = response.previewUrl.flatMap { URL(string: $0) }
    let hasWebUi: Bool = response.hasWebUi ?? false
    let latestActivity: String? = response.mergeBlockReason ?? response.plan?.summary
    let profileSnapshotMapped: Profile? = response.profileSnapshot.map { ProfileMapper.map($0) }
    let dependsOnPodIds: [String] = response.dependsOnPodIds
      ?? (response.dependsOnPodId.map { [$0] } ?? [])
    let dependencyStartedAt: Date? = response.dependencyStartedAt.map { parseDate($0) }
    let runningAt: Date? = response.runningAt.map { parseDate($0) }

    var result = Pod(
      id: response.id,
      status: status,
      pod: pod,
      hasWorktree: response.worktreePath != nil,
      branch: response.branch,
      profileName: response.profileName,
      task: response.task,
      model: response.model,
      startedAt: parseDate(response.startedAt ?? response.createdAt),
      updatedAt: parseDate(response.updatedAt),
      baseBranch: response.baseBranch,
      acFrom: response.acFrom,
      acceptanceCriteria: response.acceptanceCriteria,
      contract: response.contract,
      diffStats: diffStats,
      escalationQuestion: escalationQuestion,
      escalationOptions: escalationOptions,
      escalationType: escalationType,
      validationChecks: validationChecks,
      prUrl: prUrl,
      containerUrl: containerUrl,
      hasWebUi: hasWebUi,
      plan: plan,
      phase: phase,
      latestActivity: latestActivity,
      errorSummary: errorSummary,
      attempts: attempts,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
      commitCount: response.commitCount,
      taskSummary: taskSummary,
      linkedSessionId: response.linkedSessionId,
      profileSnapshot: profileSnapshotMapped,
      briefTitle: response.briefTitle,
      seriesId: response.seriesId,
      seriesName: response.seriesName,
      seriesDescription: response.seriesDescription,
      seriesDesign: response.seriesDesign,
      dependsOnPodIds: dependsOnPodIds,
      dependencyStartedAt: dependencyStartedAt,
      artifactsPath: response.artifactsPath,
      requireSidecars: response.requireSidecars ?? [],
      sidecarContainerIds: response.sidecarContainerIds ?? [:],
      testRunBranches: response.testRunBranches ?? [],
      runningAt: runningAt
    )
    result.worktreeCompromised = response.worktreeCompromised ?? false
    result.skipValidation = response.skipValidation
    result.validationWaiver = mapValidationWaiver(response.validationWaiver)
    result.preSubmitReview = mapPreSubmitReview(response.preSubmitReview)
    result.fixIteration = response.fixIteration ?? 0
    result.queueLength = response.queueLength ?? 0
    result.recentQueueMessages = (response.recentQueueMessages ?? []).map { msg in
      PodQueueMessage(
        id: msg.id,
        message: msg.message,
        createdAt: Date(timeIntervalSince1970: Double(msg.createdAt) / 1000)
      )
    }
    return result
  }

  static func mapPreSubmitReview(_ snapshot: PreSubmitReviewSnapshotResponse?)
    -> PreSubmitReviewSnapshot?
  {
    guard let snapshot else { return nil }
    let status =
      PreSubmitReviewSnapshot.Status(rawValue: snapshot.status) ?? .skipped
    let checkedAt = isoFormatter.date(from: snapshot.checkedAt) ?? Date()
    return PreSubmitReviewSnapshot(
      status: status,
      diffHash: snapshot.diffHash,
      reasoning: snapshot.reasoning,
      issues: snapshot.issues,
      model: snapshot.model,
      checkedAt: checkedAt
    )
  }

  static func mapValidationWaiver(_ waiver: ValidationWaiverResponse?) -> ValidationWaiver? {
    guard let waiver else { return nil }
    return ValidationWaiver(
      waivedAt: isoFormatter.date(from: waiver.waivedAt) ?? Date(),
      waivedBy: waiver.waivedBy,
      reason: waiver.reason,
      attempt: waiver.attempt,
      failedPhases: waiver.failedPhases,
      failedFactIds: waiver.failedFactIds
    )
  }

  // MARK: - Batch mapping

  public static func map(_ responses: [SessionResponse], baseURL: URL? = nil) -> [Pod] {
    responses.map { map($0, baseURL: baseURL) }
  }

  // MARK: - Helpers

  /// Maps a status string to a tri-state Bool: pass → true, fail → false, skip/uncertain/nil → nil.
  static func mapTriState(_ status: String?) -> Bool? {
    switch status {
    case "pass": true
    case "fail": false
    default: nil
    }
  }
}
