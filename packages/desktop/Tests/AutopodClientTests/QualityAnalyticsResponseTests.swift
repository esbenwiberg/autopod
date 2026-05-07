import Foundation
import Testing
@testable import AutopodClient

// MARK: - Full round-trip

@Test func qualityAnalyticsResponseDecodesRoundTrip() throws {
    let json = makeFullFixtureJSON(days: 30).data(using: .utf8)!
    let response = try JSONDecoder().decode(QualityAnalyticsResponse.self, from: json)

    // summary
    #expect(response.summary.totalPodsScored == 45)
    #expect(abs(response.summary.avgScore - 72.4) < 0.001)
    #expect(response.summary.redCount == 5)
    #expect(response.summary.yellowCount == 20)
    #expect(response.summary.greenCount == 20)
    #expect(response.summary.deltaVsPrior.direction == .up)
    #expect(abs(response.summary.deltaVsPrior.value - 3.5) < 0.001)

    // sparkline
    #expect(response.sparkline.count == 30)
    for pt in response.sparkline {
        #expect(pt.day.count == 10)  // "YYYY-MM-DD"
        #expect(pt.avgScore >= 0)
        #expect(pt.podCount >= 0)
    }

    // distribution — always 10 buckets
    #expect(response.distribution.count == 10)
    #expect(response.distribution[0].bucket == "0-9")
    #expect(response.distribution[9].bucket == "90-100")

    // reasons — all 7 fields
    #expect(response.reasons.lowReadEditRatio == 8)
    #expect(response.reasons.editsWithoutPriorRead == 3)
    #expect(response.reasons.userInterrupts == 6)
    #expect(response.reasons.validationFailed == 2)
    #expect(response.reasons.prFixAttempts == 4)
    #expect(response.reasons.editChurn == 7)
    #expect(response.reasons.tells == 1)

    // scores array — uses PodQualityScore Codable
    #expect(response.scores.count == 2)
    #expect(response.scores[0].podId == "pod-aabbccdd")
    #expect(response.scores[0].score == 85)
    #expect(response.scores[1].podId == "pod-11223344")
    #expect(response.scores[1].score == 42)
}

// MARK: - deltaVsPrior direction decodes all cases

@Test func qualityDeltaDirectionDecodesAllCases() throws {
    let upJSON   = #"{"value":3.5,"direction":"up"}"#.data(using: .utf8)!
    let downJSON = #"{"value":1.0,"direction":"down"}"#.data(using: .utf8)!
    let flatJSON = #"{"value":0.0,"direction":"flat"}"#.data(using: .utf8)!

    let up   = try JSONDecoder().decode(QualityDelta.self, from: upJSON)
    let down = try JSONDecoder().decode(QualityDelta.self, from: downJSON)
    let flat = try JSONDecoder().decode(QualityDelta.self, from: flatJSON)

    #expect(up.direction == .up)
    #expect(down.direction == .down)
    #expect(flat.direction == .flat)
}

@Test func qualityDeltaDirectionRejectsUnknown() {
    let bad = #"{"value":0.0,"direction":"sideways"}"#.data(using: .utf8)!
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(QualityDelta.self, from: bad)
    }
}

// MARK: - Sparkline: non-empty when days >= 1

@Test func qualitySparklineDecodesNonEmpty() throws {
    let json = makeSparklineJSON(days: 7).data(using: .utf8)!
    let points = try JSONDecoder().decode([QualitySparklinePoint].self, from: json)
    #expect(points.count == 7)
    for pt in points {
        #expect(pt.day.count == 10)
        #expect(pt.podCount >= 0)
    }
}

// MARK: - Distribution: always 10 buckets

@Test func qualityDistributionDecodes10Buckets() throws {
    let json = makeDistributionJSON().data(using: .utf8)!
    let buckets = try JSONDecoder().decode([QualityDistributionBucket].self, from: json)
    #expect(buckets.count == 10)
    let labels = ["0-9","10-19","20-29","30-39","40-49","50-59","60-69","70-79","80-89","90-100"]
    for (i, bucket) in buckets.enumerated() {
        #expect(bucket.bucket == labels[i])
    }
}

// MARK: - Empty fleet payload decodes without throwing

@Test func emptyFleetPayloadDecodesWithoutThrowing() throws {
    let json = makeEmptyFleetJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(QualityAnalyticsResponse.self, from: json)
    #expect(response.summary.totalPodsScored == 0)
    #expect(response.summary.redCount == 0)
    #expect(response.summary.yellowCount == 0)
    #expect(response.summary.greenCount == 0)
    #expect(response.reasons.lowReadEditRatio == 0)
    #expect(response.reasons.editsWithoutPriorRead == 0)
    #expect(response.reasons.userInterrupts == 0)
    #expect(response.reasons.validationFailed == 0)
    #expect(response.reasons.prFixAttempts == 0)
    #expect(response.reasons.editChurn == 0)
    #expect(response.reasons.tells == 0)
    #expect(response.scores.isEmpty)
}

// MARK: - Reasons decodes all 7 fields

@Test func qualityReasonsDecodesAllFields() throws {
    let json = """
    {
      "lowReadEditRatio": 1,
      "editsWithoutPriorRead": 2,
      "userInterrupts": 3,
      "validationFailed": 4,
      "prFixAttempts": 5,
      "editChurn": 6,
      "tells": 7
    }
    """.data(using: .utf8)!
    let reasons = try JSONDecoder().decode(QualityReasons.self, from: json)
    #expect(reasons.lowReadEditRatio == 1)
    #expect(reasons.editsWithoutPriorRead == 2)
    #expect(reasons.userInterrupts == 3)
    #expect(reasons.validationFailed == 4)
    #expect(reasons.prFixAttempts == 5)
    #expect(reasons.editChurn == 6)
    #expect(reasons.tells == 7)
}

// MARK: - PodQualityScore Codable (via scores array)

@Test func podQualityScoreDecodesViaScoresArray() throws {
    let json = """
    [
      {
        "podId": "abc12345",
        "score": 78,
        "readCount": 10,
        "editCount": 5,
        "readEditRatio": 2.0,
        "editsWithoutPriorRead": 0,
        "userInterrupts": 1,
        "editChurnCount": 2,
        "tellsCount": 0,
        "prFixAttempts": 0,
        "validationPassed": true,
        "inputTokens": 1000,
        "outputTokens": 500,
        "costUsd": 0.25,
        "runtime": "claude",
        "profileName": "my-profile",
        "model": "claude-sonnet-4-6",
        "finalStatus": "complete",
        "completedAt": "2026-04-30T12:00:00Z",
        "computedAt": "2026-04-30T12:00:01Z"
      }
    ]
    """.data(using: .utf8)!
    let scores = try JSONDecoder().decode([PodQualityScore].self, from: json)
    #expect(scores.count == 1)
    #expect(scores[0].podId == "abc12345")
    #expect(scores[0].score == 78)
    #expect(scores[0].validationPassed == true)
}

// MARK: - Helpers

private func makeSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")

    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: _qualityFixedDate)!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        let avgScore = String(format: "%.1f", 60.0 + Double(i))
        return #"{"day":"\#(day)","avgScore":\#(avgScore),"podCount":2}"#
    }
    return "[\(points.joined(separator: ","))]"
}

private func makeDistributionJSON() -> String {
    let labels = ["0-9","10-19","20-29","30-39","40-49","50-59","60-69","70-79","80-89","90-100"]
    let buckets = labels.enumerated().map { i, label in
        #"{"bucket":"\#(label)","count":\#(i)}"#
    }
    return "[\(buckets.joined(separator: ","))]"
}

private func makeFullFixtureJSON(days: Int) -> String {
    let scoreA = """
    {
      "podId": "pod-aabbccdd",
      "score": 85,
      "readCount": 15, "editCount": 8, "readEditRatio": 1.875,
      "editsWithoutPriorRead": 0, "userInterrupts": 0, "editChurnCount": 1,
      "tellsCount": 0, "prFixAttempts": 0, "validationPassed": true,
      "inputTokens": 2000, "outputTokens": 800, "costUsd": 0.40,
      "runtime": "claude", "profileName": "backend",
      "model": "claude-sonnet-4-6", "finalStatus": "complete",
      "completedAt": "2026-04-28T10:00:00Z", "computedAt": "2026-04-28T10:00:01Z"
    }
    """
    let scoreB = """
    {
      "podId": "pod-11223344",
      "score": 42,
      "readCount": 2, "editCount": 9, "readEditRatio": 0.222,
      "editsWithoutPriorRead": 3, "userInterrupts": 2, "editChurnCount": 4,
      "tellsCount": 1, "prFixAttempts": 1, "validationPassed": false,
      "inputTokens": 3000, "outputTokens": 1200, "costUsd": 0.65,
      "runtime": "claude", "profileName": "frontend",
      "model": null, "finalStatus": "killed",
      "completedAt": "2026-04-29T14:00:00Z", "computedAt": "2026-04-29T14:00:01Z"
    }
    """
    return """
    {
      "summary": {
        "totalPodsScored": 45,
        "avgScore": 72.4,
        "redCount": 5,
        "yellowCount": 20,
        "greenCount": 20,
        "deltaVsPrior": { "value": 3.5, "direction": "up" }
      },
      "sparkline": \(makeSparklineJSON(days: days)),
      "distribution": \(makeDistributionJSON()),
      "reasons": {
        "lowReadEditRatio": 8,
        "editsWithoutPriorRead": 3,
        "userInterrupts": 6,
        "validationFailed": 2,
        "prFixAttempts": 4,
        "editChurn": 7,
        "tells": 1
      },
      "scores": [\(scoreA), \(scoreB)]
    }
    """
}

private func makeEmptyFleetJSON() -> String {
    let emptyDist = ["0-9","10-19","20-29","30-39","40-49","50-59","60-69","70-79","80-89","90-100"]
        .map { #"{"bucket":"\#($0)","count":0}"# }
        .joined(separator: ",")
    return """
    {
      "summary": {
        "totalPodsScored": 0,
        "avgScore": 0.0,
        "redCount": 0,
        "yellowCount": 0,
        "greenCount": 0,
        "deltaVsPrior": { "value": 0.0, "direction": "flat" }
      },
      "sparkline": [],
      "distribution": [\(emptyDist)],
      "reasons": {
        "lowReadEditRatio": 0,
        "editsWithoutPriorRead": 0,
        "userInterrupts": 0,
        "validationFailed": 0,
        "prFixAttempts": 0,
        "editChurn": 0,
        "tells": 0
      },
      "scores": []
    }
    """
}

/// Fixed reference date for deterministic test output (2026-04-05).
private let _qualityFixedDate: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 4; c.day = 5
    return Calendar(identifier: .gregorian).date(from: c)!
}()
