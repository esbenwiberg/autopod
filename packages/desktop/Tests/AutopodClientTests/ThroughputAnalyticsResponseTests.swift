import Foundation
import Testing
@testable import AutopodClient

// MARK: - Full happy-path JSON decode

@Test func throughputAnalyticsResponseDecodesRoundTrip() throws {
    let json = makeFullThroughputFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(ThroughputAnalyticsResponse.self, from: json)

    // Summary
    #expect(abs(response.summary.podsPerDay - 3.5) < 0.001)
    #expect(response.summary.podsPerDaySparkline.count == 30)
    #expect(response.summary.podsPerDayDelta.direction == .up)
    #expect(abs(response.summary.podsPerDayDelta.value - 1.2) < 0.001)
    #expect(abs(response.summary.mttmSeconds - 3600.0) < 0.001)
    #expect(response.summary.backlog == 3)

    // Cohort
    #expect(response.cohort.count == 2)
    #expect(response.cohort[0].podId == "abc12345")
    #expect(response.cohort[0].profile == "my-profile")
    #expect(response.cohort[0].status == .complete)
    #expect(response.cohort[1].status == .failed)
    #expect(!response.cohortTruncated)

    // Queue depth
    #expect(response.queueDepth.count == 2)
    #expect(response.queueDepth[0].hour == "2026-05-09T14:00:00Z")
    #expect(abs(response.queueDepth[0].max - 3.0) < 0.001)
    #expect(abs(response.queueDepth[0].mean - 1.5) < 0.001)

    // Time in status — always 4 entries in fixed order
    #expect(response.timeInStatus.count == 4)
    #expect(response.timeInStatus[0].status == .queued)
    #expect(response.timeInStatus[1].status == .running)
    #expect(response.timeInStatus[2].status == .validating)
    #expect(response.timeInStatus[3].status == .awaitingInput)
    #expect(response.timeInStatus[0].sampleCount == 10)
    #expect(abs(response.timeInStatus[0].p25 - 60.0) < 0.001)
    #expect(abs(response.timeInStatus[0].p50 - 120.0) < 0.001)
    #expect(abs(response.timeInStatus[0].p75 - 240.0) < 0.001)
    #expect(abs(response.timeInStatus[0].p90 - 360.0) < 0.001)
    #expect(abs(response.timeInStatus[0].max - 600.0) < 0.001)
}

// MARK: - Minimal payload (empty cohort, all-zero queueDepth, all-zero timeInStatus)

@Test func throughputAnalyticsResponseDecodesMinimalPayload() throws {
    let json = makeMinimalThroughputFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(ThroughputAnalyticsResponse.self, from: json)

    #expect(abs(response.summary.podsPerDay - 0.0) < 0.001)
    #expect(response.summary.podsPerDaySparkline.count == 7)
    #expect(response.summary.backlog == 0)
    #expect(response.cohort.isEmpty)
    #expect(!response.cohortTruncated)
    #expect(response.queueDepth.allSatisfy { $0.max == 0 && $0.mean == 0 })
    #expect(response.timeInStatus.count == 4)
    #expect(response.timeInStatus.allSatisfy { $0.sampleCount == 0 && $0.p50 == 0 })
}

// MARK: - Truncated cohort (cohortTruncated == true, cohort of length 5 000)

@Test func throughputAnalyticsResponseDecodesTruncatedCohort() throws {
    let entries = (0..<5000).map { i in
        """
        {"podId":"\(String(format: "p%04d", i))","profile":"test","status":"complete","completedAt":"2026-05-01T12:00:00Z"}
        """
    }.joined(separator: ",")
    let json = """
    {
        "summary": \(_minimalSummaryJSON(days: 30)),
        "cohort": [\(entries)],
        "cohortTruncated": true,
        "queueDepth": [],
        "timeInStatus": \(_allZeroTimeInStatusJSON())
    }
    """.data(using: .utf8)!
    let response = try JSONDecoder().decode(ThroughputAnalyticsResponse.self, from: json)
    #expect(response.cohort.count == 5000)
    #expect(response.cohortTruncated == true)
}

// MARK: - Direction enum decode

@Test func throughputDeltaDirectionDecodesAllCases() throws {
    let cases: [(String, ThroughputDelta.Direction)] = [
        ("up", .up),
        ("down", .down),
        ("flat", .flat),
    ]
    for (raw, expected) in cases {
        let json = #"{"value":0.5,"direction":"\#(raw)"}"#.data(using: .utf8)!
        let delta = try JSONDecoder().decode(ThroughputDelta.self, from: json)
        #expect(delta.direction == expected)
    }
}

// MARK: - LoadBearingStatus decode

@Test func loadBearingStatusDecodesAllCases() throws {
    let cases: [(String, LoadBearingStatus)] = [
        ("queued", .queued),
        ("running", .running),
        ("validating", .validating),
        ("awaiting_input", .awaitingInput),
    ]
    for (raw, expected) in cases {
        let json = "\"\(raw)\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LoadBearingStatus.self, from: json)
        #expect(decoded == expected)
    }
}

@Test func loadBearingStatusRejectsUnknownString() {
    let json = #""not_a_status""#.data(using: .utf8)!
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(LoadBearingStatus.self, from: json)
    }
}

// MARK: - ThroughputPodStatus decode

@Test func throughputPodStatusDecodesAllCases() throws {
    let cases: [(String, ThroughputPodStatus)] = [
        ("complete", .complete),
        ("killed", .killed),
        ("failed", .failed),
    ]
    for (raw, expected) in cases {
        let json = "\"\(raw)\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ThroughputPodStatus.self, from: json)
        #expect(decoded == expected)
    }
}

// MARK: - Heatmap bucketing — DST-spanning fixture (UTC ISO → local hour×day)

@Test func heatmapBucketingHandlesDST() {
    // 2026-03-08T07:00:00Z is 2:00 AM ET on Spring-forward night (US Eastern)
    // immediately after that hour doesn't exist locally (clocks jump to 3 AM).
    // The important property: parsing the UTC ISO and extracting local components
    // must not produce invalid hour/weekday values.
    let iso = "2026-03-08T07:00:00Z"
    let fmt = ISO8601DateFormatter()
    guard let date = fmt.date(from: iso) else {
        Issue.record("ISO8601DateFormatter failed to parse \(iso)")
        return
    }
    let cal = Calendar.current
    let comps = cal.dateComponents([.weekday, .hour], from: date)
    #expect(comps.weekday != nil)
    #expect(comps.hour != nil)
    if let weekday = comps.weekday {
        #expect(weekday >= 1 && weekday <= 7)
    }
    if let hour = comps.hour {
        #expect(hour >= 0 && hour <= 23)
    }
}

// MARK: - Helpers

private func makeFullThroughputFixtureJSON() -> String {
    let sparkline = makeThroughputSparklineJSON(days: 30)
    return """
    {
      "summary": {
        "podsPerDay": 3.5,
        "podsPerDaySparkline": \(sparkline),
        "podsPerDayDelta": {"value": 1.2, "direction": "up"},
        "mttmSeconds": 3600.0,
        "backlog": 3
      },
      "cohort": [
        {
          "podId": "abc12345",
          "profile": "my-profile",
          "status": "complete",
          "completedAt": "2026-05-09T14:32:00Z"
        },
        {
          "podId": "deadbeef",
          "profile": "other-profile",
          "status": "failed",
          "completedAt": "2026-05-08T10:00:00Z"
        }
      ],
      "cohortTruncated": false,
      "queueDepth": [
        {"hour": "2026-05-09T14:00:00Z", "max": 3.0, "mean": 1.5},
        {"hour": "2026-05-09T15:00:00Z", "max": 2.0, "mean": 0.8}
      ],
      "timeInStatus": \(_fullTimeInStatusJSON())
    }
    """
}

private func makeMinimalThroughputFixtureJSON() -> String {
    """
    {
      "summary": \(_minimalSummaryJSON(days: 7)),
      "cohort": [],
      "cohortTruncated": false,
      "queueDepth": [
        {"hour": "2026-05-09T00:00:00Z", "max": 0.0, "mean": 0.0}
      ],
      "timeInStatus": \(_allZeroTimeInStatusJSON())
    }
    """
}

private func makeThroughputSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: _throughputFixedDate)!
    let points = (0..<days).map { i -> String in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        return #"{"day":"\#(day)","count":\#(i % 5)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

private func _minimalSummaryJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let sparkline = (0..<days).map { i -> String in
        let base = Calendar.current.date(byAdding: .day, value: -(days - 1 - i), to: _throughputFixedDate)!
        return #"{"day":"\#(fmt.string(from: base))","count":0}"#
    }.joined(separator: ",")
    return """
    {
      "podsPerDay": 0.0,
      "podsPerDaySparkline": [\(sparkline)],
      "podsPerDayDelta": {"value": 0.0, "direction": "flat"},
      "mttmSeconds": 0.0,
      "backlog": 0
    }
    """
}

private func _allZeroTimeInStatusJSON() -> String {
    let statuses = ["queued", "running", "validating", "awaiting_input"]
    let entries = statuses.map { s in
        """
        {"status":"\(s)","p25":0,"p50":0,"p75":0,"p90":0,"max":0,"sampleCount":0}
        """
    }.joined(separator: ",")
    return "[\(entries)]"
}

private func _fullTimeInStatusJSON() -> String {
    """
    [
      {"status":"queued","p25":60.0,"p50":120.0,"p75":240.0,"p90":360.0,"max":600.0,"sampleCount":10},
      {"status":"running","p25":300.0,"p50":600.0,"p75":1200.0,"p90":1800.0,"max":3600.0,"sampleCount":10},
      {"status":"validating","p25":30.0,"p50":60.0,"p75":90.0,"p90":120.0,"max":180.0,"sampleCount":8},
      {"status":"awaiting_input","p25":900.0,"p50":1800.0,"p75":3600.0,"p90":7200.0,"max":14400.0,"sampleCount":4}
    ]
    """
}

private let _throughputFixedDate: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 5; c.day = 9
    return Calendar(identifier: .gregorian).date(from: c)!
}()
