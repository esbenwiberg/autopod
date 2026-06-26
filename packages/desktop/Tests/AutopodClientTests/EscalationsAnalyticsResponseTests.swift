import Foundation
import Testing
@testable import AutopodClient

// MARK: - Full happy-path JSON decode

@Test func escalationsAnalyticsResponseDecodesRoundTrip() throws {
    let json = makeFullEscalationsFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(EscalationsAnalyticsResponse.self, from: json)

    // Summary
    #expect(abs(response.summary.selfRecoveryRate - 0.73) < 0.001)
    #expect(response.summary.cohortSize == 100)
    #expect(response.summary.humanAttentionPodCount == 27)
    #expect(response.summary.humanAttentionCount == 42)
    #expect(response.summary.askAiCount == 15)
    #expect(response.summary.dailyHumanCountSparkline.count == 30)
    #expect(response.summary.dailyHumanCountSparkline[0].day == "2026-04-12")
    #expect(response.summary.dailyHumanCountSparkline[0].count == 0)
    #expect(response.summary.selfRecoveryRateDelta.direction == .up)
    #expect(abs(response.summary.selfRecoveryRateDelta.value - 0.05) < 0.001)

    // askHumanTtr — always 8 buckets
    #expect(response.askHumanTtr.buckets.count == 8)
    #expect(response.askHumanTtr.buckets[0].label == "<1m")
    #expect(response.askHumanTtr.buckets[0].count == 3)
    #expect(response.askHumanTtr.buckets[1].label == "1\u{2013}5m")  // en-dash U+2013
    #expect(response.askHumanTtr.buckets[2].label == "5\u{2013}15m")
    #expect(response.askHumanTtr.buckets[3].label == "15m\u{2013}1h")
    #expect(response.askHumanTtr.buckets[4].label == "1\u{2013}4h")
    #expect(response.askHumanTtr.buckets[5].label == "4\u{2013}12h")
    #expect(response.askHumanTtr.buckets[6].label == "12\u{2013}24h")
    #expect(response.askHumanTtr.buckets[7].label == ">24h")
    #expect(response.askHumanTtr.resolvedCount == 38)
    #expect(response.askHumanTtr.openCount == 4)
    #expect(abs(response.askHumanTtr.maxSeconds - 90000.0) < 0.001)

    // perProfile — includes synthetic "<small profiles>" row
    #expect(response.perProfile.count == 3)
    #expect(response.perProfile[0].profile == "my-profile")
    #expect(response.perProfile[0].podCount == 60)
    #expect(response.perProfile[0].escalatedCount == 15)
    #expect(abs(response.perProfile[0].rate - 0.25) < 0.001)
    #expect(response.perProfile[2].profile == "<small profiles>")
    #expect(response.perProfile[2].podCount == 8)

    // blockerPatterns — one pattern with 10 pod IDs and count > 10
    #expect(response.blockerPatterns.count == 2)
    #expect(response.blockerPatterns[0].count == 25)
    #expect(response.blockerPatterns[0].podIds.count == 10)
    #expect(response.blockerPatterns[0].description == "Build failed: missing dependency")
}

// MARK: - Minimal payload decode

@Test func escalationsAnalyticsResponseDecodesMinimalPayload() throws {
    let json = makeMinimalEscalationsFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(EscalationsAnalyticsResponse.self, from: json)

    #expect(abs(response.summary.selfRecoveryRate - 1.0) < 0.001)
    #expect(response.summary.cohortSize == 0)
    #expect(response.summary.humanAttentionPodCount == 0)
    #expect(response.summary.humanAttentionCount == 0)
    #expect(response.summary.askAiCount == 0)
    #expect(response.summary.dailyHumanCountSparkline.count == 30)
    #expect(response.summary.dailyHumanCountSparkline.allSatisfy { $0.count == 0 })
    #expect(response.askHumanTtr.buckets.count == 8)
    #expect(response.askHumanTtr.buckets.allSatisfy { $0.count == 0 })
    #expect(response.askHumanTtr.resolvedCount == 0)
    #expect(response.askHumanTtr.openCount == 0)
    #expect(response.askHumanTtr.maxSeconds == 0)
    #expect(response.perProfile.isEmpty)
    #expect(response.blockerPatterns.isEmpty)
}

// MARK: - Snake-case key handling

@Test func escalationsAnalyticsUsesDefaultJSONDecoderNoCamelConversion() throws {
    // The daemon emits camelCase keys; we use a plain JSONDecoder (no .convertFromSnakeCase).
    // Verify that camelCase keys decode correctly without a key strategy.
    let json = """
    {
      "selfRecoveryRate": 0.9,
      "cohortSize": 10,
      "humanAttentionPodCount": 1,
      "humanAttentionCount": 1,
      "askAiCount": 0,
      "dailyHumanCountSparkline": [{"day":"2026-05-11","count":1}],
      "selfRecoveryRateDelta": {"value": 0.01, "direction": "up"}
    }
    """.data(using: .utf8)!
    let summary = try JSONDecoder().decode(EscalationsSummary.self, from: json)
    #expect(abs(summary.selfRecoveryRate - 0.9) < 0.001)
    #expect(summary.humanAttentionPodCount == 1)
    #expect(summary.askAiCount == 0)
    #expect(summary.selfRecoveryRateDelta.direction == .up)
}

// MARK: - Direction enum decode

@Test func escalationsRateDeltaDirectionDecodesAllCases() throws {
    let cases: [(String, EscalationsRateDelta.Direction)] = [
        ("up", .up),
        ("down", .down),
        ("flat", .flat),
    ]
    for (raw, expected) in cases {
        let json = #"{"value":0.05,"direction":"\#(raw)"}"#.data(using: .utf8)!
        let delta = try JSONDecoder().decode(EscalationsRateDelta.self, from: json)
        #expect(delta.direction == expected)
    }
}

// MARK: - Bucket label decode (en-dash U+2013, not hyphen-minus)

@Test func askHumanTtrBucketLabelsDecodeByteForByte() throws {
    let json = makeFullEscalationsFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(EscalationsAnalyticsResponse.self, from: json)
    let labels = response.askHumanTtr.buckets.map(\.label)
    #expect(labels == _escalationBucketLabels)
}

// MARK: - Synthetic profile row decode

@Test func escalationsPerProfileSyntheticRowDecodes() throws {
    let json = """
    {
      "profile": "<small profiles>",
      "podCount": 8,
      "escalatedCount": 3,
      "rate": 0.375
    }
    """.data(using: .utf8)!
    let row = try JSONDecoder().decode(PerProfileEscalation.self, from: json)
    #expect(row.profile == "<small profiles>")
    #expect(row.podCount == 8)
    #expect(row.escalatedCount == 3)
    #expect(abs(row.rate - 0.375) < 0.001)
}

// MARK: - Helpers

private let _escalationsFixedDate: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 5; c.day = 11
    return Calendar(identifier: .gregorian).date(from: c)!
}()

private let _escalationsDayFmt: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

private let _escalationBucketLabels = ["<1m", "1\u{2013}5m", "5\u{2013}15m", "15m\u{2013}1h",
                                        "1\u{2013}4h", "4\u{2013}12h", "12\u{2013}24h", ">24h"]

private func _escalationDay(offsetDays: Int) -> String {
    let target = Calendar.current.date(byAdding: .day, value: offsetDays, to: _escalationsFixedDate)!
    return _escalationsDayFmt.string(from: target)
}

private func makeFullEscalationsFixtureJSON() -> String {
    let sparkline = (0..<30).map { i -> String in
        let day = _escalationDay(offsetDays: -(29 - i))
        return #"{"day":"\#(day)","count":\#(i % 4)}"#
    }.joined(separator: ",")

    let bucketCounts = [3, 8, 10, 7, 5, 3, 2, 0]
    let bucketsJSON = zip(_escalationBucketLabels, bucketCounts).map { label, count in
        #"{"label":"\#(label)","count":\#(count)}"#
    }.joined(separator: ",")

    let podIds = (0..<10).map { i in #""pod\#(i)abc1""# }.joined(separator: ",")

    return """
    {
      "summary": {
        "selfRecoveryRate": 0.73,
        "cohortSize": 100,
        "humanAttentionPodCount": 27,
        "humanAttentionCount": 42,
        "askAiCount": 15,
        "dailyHumanCountSparkline": [\(sparkline)],
        "selfRecoveryRateDelta": {"value": 0.05, "direction": "up"}
      },
      "askHumanTtr": {
        "buckets": [\(bucketsJSON)],
        "resolvedCount": 38,
        "openCount": 4,
        "maxSeconds": 90000.0
      },
      "perProfile": [
        {"profile": "my-profile", "podCount": 60, "escalatedCount": 15, "rate": 0.25},
        {"profile": "other-profile", "podCount": 32, "escalatedCount": 9, "rate": 0.28125},
        {"profile": "<small profiles>", "podCount": 8, "escalatedCount": 3, "rate": 0.375}
      ],
      "blockerPatterns": [
        {
          "description": "Build failed: missing dependency",
          "count": 25,
          "podIds": [\(podIds)]
        },
        {
          "description": "Network timeout on external API",
          "count": 8,
          "podIds": ["pod11abc1","pod12abc1"]
        }
      ]
    }
    """
}

private func makeMinimalEscalationsFixtureJSON() -> String {
    let sparkline = (0..<30).map { i -> String in
        return #"{"day":"\#(_escalationDay(offsetDays: -(29 - i)))","count":0}"#
    }.joined(separator: ",")

    let bucketsJSON = _escalationBucketLabels.map { label in
        #"{"label":"\#(label)","count":0}"#
    }.joined(separator: ",")

    return """
    {
      "summary": {
        "selfRecoveryRate": 1.0,
        "cohortSize": 0,
        "humanAttentionPodCount": 0,
        "humanAttentionCount": 0,
        "askAiCount": 0,
        "dailyHumanCountSparkline": [\(sparkline)],
        "selfRecoveryRateDelta": {"value": 0.0, "direction": "flat"}
      },
      "askHumanTtr": {
        "buckets": [\(bucketsJSON)],
        "resolvedCount": 0,
        "openCount": 0,
        "maxSeconds": 0.0
      },
      "perProfile": [],
      "blockerPatterns": []
    }
    """
}
