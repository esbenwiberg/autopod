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

  // MARK: - SessionResponse → Pod

  public static func map(_ response: SessionResponse) -> Pod {
    let status = PodStatus(rawValue: response.status) ?? .queued
    let pod: PodConfig = {
      if let p = response.pod {
        let agent = AgentMode(rawValue: p.agentMode) ?? .auto
        let output = OutputTarget(rawValue: p.output) ?? .pr
        return PodConfig(agentMode: agent, output: output, validate: p.validate, promotable: p.promotable)
      }
      return PodConfig.fromLegacy(response.outputMode)
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
      let healthCheck = HealthCheckDetail(
        status: v.smoke.health.status,
        url: v.smoke.health.url,
        responseCode: v.smoke.health.responseCode,
        duration: v.smoke.health.duration
      )
      let pages: [PageDetail]? = v.smoke.status == "pass" ? nil : v.smoke.pages.map { p in
        PageDetail(
          path: p.path,
          status: p.status,
          consoleErrors: p.consoleErrors,
          assertions: p.assertions.map { a in
            AssertionDetail(selector: a.selector, type: a.type, expected: a.expected, actual: a.actual, passed: a.passed)
          },
          loadTime: p.loadTime,
          screenshotBase64: p.screenshotBase64
        )
      }
      let acValidation: Bool? = v.acValidation.flatMap { $0.status == "skip" ? nil : ($0.status == "pass") }
      let acChecks: [AcCheckDetail]? = v.acValidation?.results.map { r in
        AcCheckDetail(criterion: r.criterion, passed: r.passed, reasoning: r.reasoning, screenshot: r.screenshot, validationType: r.validationType)
      }
      let requirementsCheck: [RequirementCheckDetail]? = v.taskReview?.requirementsCheck?.map { r in
        RequirementCheckDetail(criterion: r.criterion, met: r.met, note: r.note)
      }
      let taskReviewScreenshots: [String]? = {
        guard let ss = v.taskReview?.screenshots, !ss.isEmpty else { return nil }
        return ss
      }()
      return ValidationChecks(
        smoke: v.smoke.status == "pass",
        tests: mapTriState(v.test?.status),
        review: mapTriState(v.taskReview?.status),
        buildOutput: buildOutput,
        testOutput: testOutput,
        reviewIssues: v.taskReview?.issues,
        reviewReasoning: v.taskReview?.reasoning,
        reviewSkipReason: v.reviewSkipReason,
        healthCheck: healthCheck,
        pages: pages,
        acValidation: acValidation,
        acChecks: acChecks,
        requirementsCheck: requirementsCheck,
        taskReviewScreenshots: taskReviewScreenshots,
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
      guard response.validationAttempts > 0 else { return nil }
      return AttemptInfo(
        current: response.validationAttempts,
        max: response.maxValidationAttempts
      )
    }()

    // Map task summary
    let taskSummary: TaskSummary? = {
      guard let ts = response.taskSummary else { return nil }
      return TaskSummary(
        actualSummary: ts.actualSummary,
        deviations: ts.deviations.map {
          DeviationItem(step: $0.step, planned: $0.planned, actual: $0.actual, reason: $0.reason)
        }
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

    return Pod(
      id: response.id,
      status: status,
      pod: pod,
      branch: response.branch,
      profileName: response.profileName,
      task: response.task,
      model: response.model,
      startedAt: parseDate(response.startedAt ?? response.createdAt),
      updatedAt: parseDate(response.updatedAt),
      baseBranch: response.baseBranch,
      acFrom: response.acFrom,
      acceptanceCriteria: response.acceptanceCriteria,
      diffStats: diffStats,
      escalationQuestion: escalationQuestion,
      escalationOptions: escalationOptions,
      escalationType: escalationType,
      validationChecks: validationChecks,
      prUrl: response.prUrl.flatMap { URL(string: $0) },
      containerUrl: response.previewUrl.flatMap { URL(string: $0) },
      plan: plan,
      phase: phase,
      latestActivity: response.mergeBlockReason ?? response.plan?.summary,
      errorSummary: errorSummary,
      attempts: attempts,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
      commitCount: response.commitCount,
      taskSummary: taskSummary,
      linkedSessionId: response.linkedSessionId,
      profileSnapshot: response.profileSnapshot.map { ProfileMapper.map($0) },
      seriesId: response.seriesId,
      seriesName: response.seriesName,
      dependsOnPodIds: response.dependsOnPodIds
        ?? (response.dependsOnPodId.map { [$0] } ?? []),
      dependencyStartedAt: response.dependencyStartedAt.map { parseDate($0) }
    )
  }

  // MARK: - Batch mapping

  public static func map(_ responses: [SessionResponse]) -> [Pod] {
    responses.map { map($0) }
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
