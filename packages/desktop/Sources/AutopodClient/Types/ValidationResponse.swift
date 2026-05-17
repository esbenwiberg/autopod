import Foundation

// MARK: - Validation override (mirrors ValidationOverride in validation.ts)

public struct ValidationOverrideResponse: Codable, Sendable {
  public let findingId: String
  public let description: String
  public let action: String  // "dismiss" | "guidance"
  public let reason: String?
  public let guidance: String?
  public let createdAt: String
}

// MARK: - Validation finding (mirrors ValidationFinding in validation.ts)

public struct ValidationFindingResponse: Codable, Sendable {
  public let id: String
  public let source: String  // "ac_validation" | "fact_validation" | "task_review" | "requirements_check"
  public let description: String
  public let reasoning: String?
}

// MARK: - Screenshot reference (replaces base64 inline images)

/// DTO for a screenshot served at `GET /pods/:id/screenshots/:source/:filename`.
/// Field names match the daemon's wire shape exactly — no remapping.
public struct ScreenshotRefResponse: Codable, Sendable, Hashable {
  public let url: String     // "/pods/:podId/screenshots/:source/:filename"
  public let source: String  // "smoke" | "ac" | "review"
  public let path: String    // page path | criterion text | index
}

// MARK: - Validation result (mirrors packages/shared/src/types/validation.ts)

public struct ValidationResponse: Codable, Sendable {
  public let podId: String
  public let attempt: Int
  public let timestamp: String
  public let smoke: SmokeResultResponse
  public let test: TestResultResponse?
  public let lint: LintResultResponse?
  public let sast: SastResultResponse?
  public let acValidation: AcValidationResponse?
  public let factValidation: FactValidationResponse?
  /// Machine-readable skip reason when acValidation is null. Lets the UI tell
  /// "skipped because earlier phases failed" apart from "no criteria configured".
  /// Values: "upstream-failed" | "profile-skip" | "health-failed" | "no-criteria".
  public let acSkipReason: String?
  public let taskReview: TaskReviewResponse?
  public let reviewSkipReason: String?
  /// Machine-readable kind paired with reviewSkipReason. Values:
  /// "upstream-failed" | "profile-skip" | "no-changes" | "review-failed" | "review-timeout".
  public let reviewSkipKind: String?
  public let overall: String  // "pass" | "fail"
  public let duration: Int
}

// MARK: - Smoke

public struct SmokeResultResponse: Codable, Sendable {
  public let status: String
  public let build: BuildResultResponse
  public let health: HealthResultResponse
  public let pages: [PageResultResponse]
}

public struct BuildResultResponse: Codable, Sendable {
  public let status: String
  public let output: String
  public let duration: Int
}

public struct HealthResultResponse: Codable, Sendable {
  public let status: String
  public let url: String
  public let responseCode: Int?
  public let duration: Int
  public let responseBody: String?
}

public struct PageResultResponse: Codable, Sendable {
  public let path: String
  public let status: String
  public let screenshot: ScreenshotRefResponse?
  public let consoleErrors: [String]
  public let assertions: [AssertionResultResponse]
  public let loadTime: Int
}

public struct AssertionResultResponse: Codable, Sendable {
  public let selector: String
  public let type: String
  public let expected: String?
  public let actual: String?
  public let passed: Bool

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    selector = try c.decode(String.self, forKey: .selector)
    type = try c.decode(String.self, forKey: .type)
    expected = try c.decodeIfPresent(String.self, forKey: .expected)
    actual = try c.decodeIfPresent(String.self, forKey: .actual)
    passed = try decodeBoolOrInt(c, key: .passed)
  }
}

// MARK: - Test

public struct TestResultResponse: Codable, Sendable {
  public let status: String
  public let duration: Int
  public let stdout: String?
  public let stderr: String?
}

// MARK: - Lint

public struct LintResultResponse: Codable, Sendable {
  public let status: String
  public let output: String
  public let duration: Int
}

// MARK: - SAST

public struct SastResultResponse: Codable, Sendable {
  public let status: String
  public let output: String
  public let duration: Int
}

// MARK: - AC Validation

public struct AcValidationResponse: Codable, Sendable {
  public let status: String
  public let results: [AcCheckResponse]
  public let model: String
}

public struct AcCheckResponse: Codable, Sendable {
  public let criterion: String
  public let passed: Bool
  public let screenshot: ScreenshotRefResponse?
  public let reasoning: String
  public let validationType: String?  // "web-ui" | "api" | "none"

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    criterion = try c.decode(String.self, forKey: .criterion)
    passed = try decodeBoolOrInt(c, key: .passed)
    screenshot = try c.decodeIfPresent(ScreenshotRefResponse.self, forKey: .screenshot)
    reasoning = try c.decode(String.self, forKey: .reasoning)
    validationType = try c.decodeIfPresent(String.self, forKey: .validationType)
  }
}

// MARK: - Fact Validation

public struct FactValidationResponse: Codable, Sendable {
  public let status: String
  public let results: [FactCheckResponse]
}

public struct FactCheckResponse: Codable, Sendable {
  public let factId: String
  public let proves: [String]
  public let artifactPath: String
  public let command: String
  public let passed: Bool
  public let reasoning: String
  public let stdout: String?
  public let stderr: String?

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    factId = try c.decode(String.self, forKey: .factId)
    proves = try c.decode([String].self, forKey: .proves)
    artifactPath = try c.decode(String.self, forKey: .artifactPath)
    command = try c.decode(String.self, forKey: .command)
    passed = try decodeBoolOrInt(c, key: .passed)
    reasoning = try c.decode(String.self, forKey: .reasoning)
    stdout = try c.decodeIfPresent(String.self, forKey: .stdout)
    stderr = try c.decodeIfPresent(String.self, forKey: .stderr)
  }
}

// MARK: - Task Review

public struct TaskReviewResponse: Codable, Sendable {
  public let status: String  // "pass" | "fail" | "uncertain"
  public let reasoning: String
  public let issues: [String]
  public let model: String
  public let screenshots: [ScreenshotRefResponse]
  public let diff: String
  public let requirementsCheck: [RequirementsCheckResponse]?
}

public struct RequirementsCheckResponse: Codable, Sendable {
  public let criterion: String
  public let met: Bool
  public let note: String?

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    criterion = try c.decode(String.self, forKey: .criterion)
    met = try decodeBoolOrInt(c, key: .met)
    note = try c.decodeIfPresent(String.self, forKey: .note)
  }
}
