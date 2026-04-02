import Foundation
import AutopodClient
import AutopodUI

/// Maps daemon API response types to AutopodUI display models.
public enum SessionMapper {

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

  // MARK: - SessionResponse → Session

  public static func map(_ response: SessionResponse) -> Session {
    let status = SessionStatus(rawValue: response.status) ?? .queued
    let outputMode = OutputMode(rawValue: response.outputMode) ?? .pr

    // Map escalation question from pending escalation
    let escalationQuestion: String? = {
      guard let esc = response.pendingEscalation, esc.response == nil else { return nil }
      return esc.payload.question ?? esc.payload.description
    }()

    // Map validation checks from last validation result
    let validationChecks: ValidationChecks? = {
      guard let v = response.lastValidationResult else { return nil }
      return ValidationChecks(
        smoke: v.smoke.status == "pass",
        tests: v.test?.status == "pass",
        review: v.taskReview?.status == "pass"
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

    // Error summary for failed sessions
    let errorSummary: String? = {
      guard status == .failed || status == .killed else { return nil }
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

    return Session(
      id: response.id,
      status: status,
      outputMode: outputMode,
      branch: response.branch,
      profileName: response.profileName,
      task: response.task,
      model: response.model,
      startedAt: parseDate(response.startedAt ?? response.createdAt),
      baseBranch: response.baseBranch,
      acFrom: response.acFrom,
      acceptanceCriteria: response.acceptanceCriteria,
      diffStats: diffStats,
      escalationQuestion: escalationQuestion,
      validationChecks: validationChecks,
      prUrl: response.prUrl.flatMap { URL(string: $0) },
      containerUrl: response.previewUrl.flatMap { URL(string: $0) },
      phase: phase,
      latestActivity: response.plan?.summary,
      errorSummary: errorSummary,
      attempts: attempts,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
      commitCount: response.commitCount,
      linkedSessionId: response.linkedSessionId
    )
  }

  // MARK: - Batch mapping

  public static func map(_ responses: [SessionResponse]) -> [Session] {
    responses.map { map($0) }
  }
}
