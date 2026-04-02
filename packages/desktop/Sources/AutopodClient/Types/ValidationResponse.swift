import Foundation

// MARK: - Validation result (mirrors packages/shared/src/types/validation.ts)

public struct ValidationResponse: Codable, Sendable {
  public let sessionId: String
  public let attempt: Int
  public let timestamp: String
  public let smoke: SmokeResultResponse
  public let test: TestResultResponse?
  public let acValidation: AcValidationResponse?
  public let taskReview: TaskReviewResponse?
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
}

public struct PageResultResponse: Codable, Sendable {
  public let path: String
  public let status: String
  public let screenshotPath: String
  public let screenshotBase64: String?
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

// MARK: - AC Validation

public struct AcValidationResponse: Codable, Sendable {
  public let status: String
  public let results: [AcCheckResponse]
  public let model: String
}

public struct AcCheckResponse: Codable, Sendable {
  public let criterion: String
  public let passed: Bool
  public let screenshot: String?
  public let reasoning: String

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    criterion = try c.decode(String.self, forKey: .criterion)
    passed = try decodeBoolOrInt(c, key: .passed)
    screenshot = try c.decodeIfPresent(String.self, forKey: .screenshot)
    reasoning = try c.decode(String.self, forKey: .reasoning)
  }
}

// MARK: - Task Review

public struct TaskReviewResponse: Codable, Sendable {
  public let status: String  // "pass" | "fail" | "uncertain"
  public let reasoning: String
  public let issues: [String]
  public let model: String
  public let screenshots: [String]
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
