import Foundation
import Testing
@testable import AutopodClient

// MARK: - CostAnalyticsResponse decoding tests

@Test func costAnalyticsResponseDecodesRoundTrip() throws {
    let json = """
    {
      "total": 42.75,
      "sparkline": \(makeSparklineJSON(days: 30)),
      "deltaVsPrior": { "value": 5.25, "direction": "up" },
      "byPhase": [
        { "phase": "agent_initial", "costUsd": 20.00 },
        { "phase": "agent_rework_1", "costUsd": 8.50 },
        { "phase": "review", "costUsd": 9.25 },
        { "phase": "plan_eval", "costUsd": 3.00 },
        { "phase": "agent_legacy", "costUsd": 2.00 }
      ],
      "byProfileModel": [
        { "profile": "my-app", "model": "claude-sonnet-4-6", "costUsd": 30.00, "podCount": 5 },
        { "profile": "backend", "model": null, "costUsd": 12.75, "podCount": 2 }
      ],
      "top10": [
        {
          "podId": "abcd1234",
          "profile": "my-app",
          "model": "claude-sonnet-4-6",
          "finalStatus": "complete",
          "costUsd": 8.40,
          "completedAt": "2026-04-30T12:00:00Z"
        }
      ],
      "waste": { "total": 3.50, "podCount": 2 }
    }
    """.data(using: .utf8)!

    let response = try JSONDecoder().decode(CostAnalyticsResponse.self, from: json)

    #expect(response.total == 42.75)
    #expect(response.sparkline.count == 30)
    #expect(response.sparkline[0].day.count == 10)  // "YYYY-MM-DD"
    #expect(response.deltaVsPrior.value == 5.25)
    #expect(response.deltaVsPrior.direction == .up)
    #expect(response.byPhase.count == 5)
    #expect(response.byPhase[0].phase == "agent_initial")
    #expect(response.byPhase[0].costUsd == 20.00)
    #expect(response.byProfileModel.count == 2)
    #expect(response.byProfileModel[0].profile == "my-app")
    #expect(response.byProfileModel[0].model == "claude-sonnet-4-6")
    #expect(response.byProfileModel[0].podCount == 5)
    #expect(response.byProfileModel[1].model == nil)
    #expect(response.top10.count == 1)
    #expect(response.top10[0].podId == "abcd1234")
    #expect(response.top10[0].finalStatus == "complete")
    #expect(response.top10[0].costUsd == 8.40)
    #expect(response.waste.total == 3.50)
    #expect(response.waste.podCount == 2)
}

@Test func profileModelCellDecodesNullModel() throws {
    let json = """
    { "profile": "codex-profile", "model": null, "costUsd": 5.00, "podCount": 3 }
    """.data(using: .utf8)!

    let cell = try JSONDecoder().decode(ProfileModelCell.self, from: json)
    #expect(cell.profile == "codex-profile")
    #expect(cell.model == nil)
    #expect(cell.costUsd == 5.00)
    #expect(cell.podCount == 3)
}

@Test func costDeltaDirectionDecodesAllCases() throws {
    let upJSON    = #"{"value":1.0,"direction":"up"}"#.data(using: .utf8)!
    let downJSON  = #"{"value":2.0,"direction":"down"}"#.data(using: .utf8)!
    let flatJSON  = #"{"value":0.0,"direction":"flat"}"#.data(using: .utf8)!

    let up   = try JSONDecoder().decode(CostDelta.self, from: upJSON)
    let down = try JSONDecoder().decode(CostDelta.self, from: downJSON)
    let flat = try JSONDecoder().decode(CostDelta.self, from: flatJSON)

    #expect(up.direction == .up)
    #expect(down.direction == .down)
    #expect(flat.direction == .flat)
}

@Test func costDeltaDirectionRejectsUnknownString() {
    let badJSON = #"{"value":0.0,"direction":"sideways"}"#.data(using: .utf8)!
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(CostDelta.self, from: badJSON)
    }
}

@Test func costSparklineDecodes30Elements() throws {
    let json = makeSparklineJSON(days: 30).data(using: .utf8)!
    let points = try JSONDecoder().decode([SparklinePoint].self, from: json)
    #expect(points.count == 30)
    for pt in points {
        #expect(pt.day.count == 10)  // "YYYY-MM-DD"
    }
    // cost values increase by 0.10 per day
    #expect(abs(points[0].costUsd - 0.00) < 0.001)
    #expect(abs(points[1].costUsd - 0.10) < 0.001)
    #expect(abs(points[29].costUsd - 2.90) < 0.001)
}

// MARK: - Helper

/// Generates a JSON array of N SparklinePoint objects with incrementing costUsd values.
private func makeSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")

    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: _fixedDate)!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        let cost = String(format: "%.2f", Double(i) * 0.10)
        return #"{"day":"\#(day)","costUsd":\#(cost)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

/// Fixed reference date for deterministic test output (2026-04-05).
private let _fixedDate: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 4; c.day = 5
    return Calendar(identifier: .gregorian).date(from: c)!
}()
