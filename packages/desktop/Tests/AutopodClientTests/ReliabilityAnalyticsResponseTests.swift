import Foundation
import Testing
@testable import AutopodClient

// MARK: - Full round-trip

@Test func reliabilityAnalyticsResponseDecodesRoundTrip() throws {
    let json = makeFullFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(ReliabilityAnalyticsResponse.self, from: json)

    #expect(abs(response.firstPassRate - 0.75) < 0.001)
    #expect(response.firstPassRateSparkline.count == 30)
    #expect(response.firstPassRateDelta.direction == .up)
    #expect(abs(response.firstPassRateDelta.value - 5.0) < 0.001)

    // Funnel bands
    #expect(response.funnel.bands.count == 8)
    #expect(response.funnel.bands[0].band == .queued)
    #expect(response.funnel.bands[0].count == 100)
    #expect(response.funnel.bands[7].band == .complete)
    #expect(response.funnel.bands[7].count == 75)

    // Drops
    #expect(response.funnel.drops.count == 1)
    let drop = response.funnel.drops[0]
    #expect(drop.from == .running)
    #expect(drop.to == .failed)
    #expect(drop.count == 5)
    #expect(drop.topPods.count == 1)
    #expect(drop.overflow == 5)

    // Stage failures
    #expect(response.stageFailures.count == 1)
    #expect(response.stageFailures[0].stage == .test)
    #expect(response.stageFailures[0].podsRan == 50)
    #expect(response.stageFailures[0].podsFailed == 10)

    // Profile heatmap
    #expect(response.profileHeatmap.count == 1)
    #expect(response.profileHeatmap[0].profile == "my-profile")
    #expect(response.profileHeatmap[0].stages.count == 1)

    // Summary
    #expect(response.summary.topFailureStage == .test)
    #expect(abs(response.summary.avgReworkCount - 0.25) < 0.001)
    #expect(response.summary.totalPodsInWindow == 100)
}

// MARK: - topFailureStage: empty string → nil

@Test func topFailureStageEmptyStringDecodesToNil() throws {
    let json = """
    {
      "topFailureStage": "",
      "avgReworkCount": 0.0,
      "totalPodsInWindow": 10
    }
    """.data(using: .utf8)!
    let summary = try JSONDecoder().decode(ReliabilitySummary.self, from: json)
    #expect(summary.topFailureStage == nil)
}

// MARK: - topFailureStage: "test" → .test

@Test func topFailureStageTestStringDecodesToTest() throws {
    let json = """
    {
      "topFailureStage": "test",
      "avgReworkCount": 1.5,
      "totalPodsInWindow": 20
    }
    """.data(using: .utf8)!
    let summary = try JSONDecoder().decode(ReliabilitySummary.self, from: json)
    #expect(summary.topFailureStage == .test)
}

// MARK: - FunnelBand decodes all 8 cases

@Test func funnelBandDecodesAllCases() throws {
    let cases: [(String, FunnelBand)] = [
        ("queued", .queued),
        ("provisioning", .provisioning),
        ("running", .running),
        ("validating", .validating),
        ("validated", .validated),
        ("approved", .approved),
        ("merging", .merging),
        ("complete", .complete),
    ]
    for (raw, expected) in cases {
        let json = "\"\(raw)\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(FunnelBand.self, from: json)
        #expect(decoded == expected)
    }
}

@Test func funnelBandRejectsUnknownString() {
    let json = #""not_a_band""#.data(using: .utf8)!
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(FunnelBand.self, from: json)
    }
}

// MARK: - ValidationStage decodes all 8 cases

@Test func validationStageDecodesAllCases() throws {
    let cases: [(String, ValidationStage)] = [
        ("build", .build),
        ("health", .health),
        ("smoke", .smoke),
        ("test", .test),
        ("lint", .lint),
        ("sast", .sast),
        ("acValidation", .acValidation),
        ("taskReview", .taskReview),
    ]
    for (raw, expected) in cases {
        let json = "\"\(raw)\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ValidationStage.self, from: json)
        #expect(decoded == expected)
    }
}

@Test func validationStageRejectsUnknownString() {
    let json = #""not_a_stage""#.data(using: .utf8)!
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(ValidationStage.self, from: json)
    }
}

// MARK: - FinalStatus decodes all 3 cases

@Test func finalStatusDecodesAllCases() throws {
    let cases: [(String, FinalStatus)] = [
        ("complete", .complete),
        ("killed", .killed),
        ("failed", .failed),
    ]
    for (raw, expected) in cases {
        let json = "\"\(raw)\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(FinalStatus.self, from: json)
        #expect(decoded == expected)
    }
}

@Test func finalStatusRejectsUnknownString() {
    let json = #""rejected""#.data(using: .utf8)!
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(FinalStatus.self, from: json)
    }
}

// MARK: - Sparkline: 30 elements

@Test func sparklineDecodes30Elements() throws {
    let json = makeSparklineJSON(days: 30).data(using: .utf8)!
    let points = try JSONDecoder().decode([SparklineRatePoint].self, from: json)
    #expect(points.count == 30)
    for pt in points {
        #expect(pt.day.count == 10)  // "YYYY-MM-DD"
        #expect(pt.rate >= 0 && pt.rate <= 1)
    }
}

// MARK: - Drop with overflow: 5

@Test func dropEntryWithOverflowDecodes() throws {
    let json = """
    {
      "from": "running",
      "to": "failed",
      "count": 15,
      "topPods": [
        {
          "podId": "abc12345",
          "profile": "my-profile",
          "finalStatus": "failed",
          "completedAt": "2026-04-30T12:00:00Z"
        }
      ],
      "overflow": 5
    }
    """.data(using: .utf8)!
    let drop = try JSONDecoder().decode(DropEntry.self, from: json)
    #expect(drop.from == .running)
    #expect(drop.to == .failed)
    #expect(drop.count == 15)
    #expect(drop.topPods.count == 1)
    #expect(drop.topPods[0].podId == "abc12345")
    #expect(drop.overflow == 5)
}

// MARK: - Helpers

private func makeSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")

    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: _reliabilityFixedDate)!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        let rate = String(format: "%.4f", Double(i) / Double(days))
        return #"{"day":"\#(day)","rate":\#(rate)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

private func makeFullFixtureJSON() -> String {
    """
    {
      "firstPassRate": 0.75,
      "firstPassRateSparkline": \(makeSparklineJSON(days: 30)),
      "firstPassRateDelta": { "value": 5.0, "direction": "up" },
      "funnel": {
        "bands": [
          { "band": "queued",       "count": 100 },
          { "band": "provisioning", "count": 98 },
          { "band": "running",      "count": 95 },
          { "band": "validating",   "count": 90 },
          { "band": "validated",    "count": 85 },
          { "band": "approved",     "count": 82 },
          { "band": "merging",      "count": 78 },
          { "band": "complete",     "count": 75 }
        ],
        "drops": [
          {
            "from": "running",
            "to": "failed",
            "count": 5,
            "topPods": [
              {
                "podId": "deadbeef",
                "profile": "my-profile",
                "finalStatus": "failed",
                "completedAt": "2026-04-30T10:00:00Z"
              }
            ],
            "overflow": 5
          }
        ]
      },
      "stageFailures": [
        { "stage": "test", "podsRan": 50, "podsFailed": 10, "failureRate": 0.2 }
      ],
      "profileHeatmap": [
        {
          "profile": "my-profile",
          "stages": [
            { "stage": "test", "podsRan": 50, "podsFailed": 10, "failureRate": 0.2 }
          ]
        }
      ],
      "summary": {
        "topFailureStage": "test",
        "avgReworkCount": 0.25,
        "totalPodsInWindow": 100
      }
    }
    """
}

private let _reliabilityFixedDate: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 4; c.day = 5
    return Calendar(identifier: .gregorian).date(from: c)!
}()
