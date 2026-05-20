import Foundation
import Testing
@testable import AutopodClient

// MARK: - Full happy-path JSON decode

@Test func modelsAnalyticsResponseDecodesRoundTrip() throws {
    let json = makeFullModelsFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(ModelsAnalyticsResponse.self, from: json)

    // Summary
    #expect(response.summary.cheapestDollarPerPrModel == "claude-haiku-4-5")
    #expect(abs((response.summary.cheapestDollarPerPr ?? 0) - 0.42) < 0.001)
    #expect(response.summary.bestQualityModel == "claude-opus-4-7")
    #expect(abs((response.summary.bestQuality ?? 0) - 88.0) < 0.001)
    #expect(response.summary.mostUsedModel == "claude-sonnet-4-6")
    #expect(response.summary.mostUsedPodCount == 200)
    #expect(response.summary.cohortSize == 350)
    #expect(response.summary.mostUsedDailySparkline.count == 30)
    #expect(response.summary.cheapestDollarPerPrDelta.direction == .down)
    #expect(abs(response.summary.cheapestDollarPerPrDelta.value - (-0.05)) < 0.001)

    // byModel — 2 rows including one with dollarPerPr: null
    #expect(response.byModel.count == 2)
    let first = response.byModel[0]
    #expect(first.model == "claude-sonnet-4-6")
    #expect(first.podCount == 200)
    #expect(first.successRate > 0)
    #expect(first.dollarPerPr != nil)
    #expect(first.completeCostUsd != nil)
    let unknown = response.byModel[1]
    #expect(unknown.model == "<unknown>")
    #expect(unknown.dollarPerPr == nil)
    #expect(unknown.totalCostUsd == nil)
    #expect(unknown.completeCostUsd == nil)

    // byRuntime — always exactly 3 entries
    #expect(response.byRuntime.count == 3)
    #expect(response.byRuntime[0].runtime == .claude)
    #expect(response.byRuntime[1].runtime == .codex)
    #expect(response.byRuntime[2].runtime == .copilot)
    // copilot has zero pods
    #expect(response.byRuntime[2].podCount == 0)
    #expect(response.byRuntime[2].dollarPerPr == nil)

    // failureStageMatrix — one row with all 8 stages
    #expect(response.failureStageMatrix.count == 1)
    let matrixRow = response.failureStageMatrix[0]
    #expect(matrixRow.model == "claude-sonnet-4-6")
    #expect(matrixRow.stages.count == 8)
    // First stage is build; some cells have podsRan == 0
    #expect(matrixRow.stages[0].stage == .build)
    let zeroCell = matrixRow.stages.first(where: { $0.podsRan == 0 })
    #expect(zeroCell != nil)

    // unknownModels
    #expect(response.unknownModels.count == 1)
    #expect(response.unknownModels[0].rawModel == "gpt-unknown-v1")
    #expect(response.unknownModels[0].podCount == 50)
}

// MARK: - Minimal / empty payload

@Test func modelsAnalyticsResponseDecodesMinimalPayload() throws {
    let json = makeMinimalModelsFixtureJSON(days: 7).data(using: .utf8)!
    let response = try JSONDecoder().decode(ModelsAnalyticsResponse.self, from: json)

    #expect(response.summary.cohortSize == 0)
    #expect(response.summary.cheapestDollarPerPrModel == nil)
    #expect(response.summary.cheapestDollarPerPr == nil)
    #expect(response.summary.bestQualityModel == nil)
    #expect(response.summary.bestQuality == nil)
    #expect(response.summary.mostUsedModel == nil)
    #expect(response.summary.mostUsedPodCount == nil)
    #expect(response.summary.mostUsedDailySparkline.count == 7)
    #expect(response.summary.mostUsedDailySparkline.allSatisfy { $0.count == 0 })
    #expect(response.summary.cheapestDollarPerPrDelta.direction == .flat)
    #expect(response.summary.cheapestDollarPerPrDelta.value == 0)
    #expect(response.byModel.isEmpty)
    #expect(response.byRuntime.count == 3)
    #expect(response.byRuntime.allSatisfy { $0.podCount == 0 })
    #expect(response.failureStageMatrix.isEmpty)
    #expect(response.unknownModels.isEmpty)
}

// MARK: - Null-tolerant: cost fields

@Test func modelsAnalyticsResponseDecodesNullCostFields() throws {
    let json = """
    {
      "model": "<unknown>",
      "podCount": 10,
      "completeCount": 5,
      "killedCount": 3,
      "failedCount": 2,
      "successRate": 0.5,
      "totalCostUsd": null,
      "dollarPerPr": null,
      "scoredCount": 3,
      "avgQuality": 72.0,
      "meanTtmSeconds": 600.0,
      "escalatedCount": 1,
      "escalationRate": 0.1,
      "completeCostUsd": null
    }
    """.data(using: .utf8)!
    let row = try JSONDecoder().decode(PerModelAggregate.self, from: json)
    #expect(row.totalCostUsd == nil)
    #expect(row.dollarPerPr == nil)
    #expect(row.completeCostUsd == nil)
    #expect(row.model == "<unknown>")
}

// MARK: - Null-tolerant: quality and TTM fields

@Test func modelsAnalyticsResponseDecodesNullQualityAndTtm() throws {
    let json = """
    {
      "model": "claude-haiku-4-5",
      "podCount": 1,
      "completeCount": 0,
      "killedCount": 1,
      "failedCount": 0,
      "successRate": 0.0,
      "totalCostUsd": 0.01,
      "dollarPerPr": null,
      "scoredCount": 0,
      "avgQuality": null,
      "meanTtmSeconds": null,
      "escalatedCount": 0,
      "escalationRate": 0.0,
      "completeCostUsd": null
    }
    """.data(using: .utf8)!
    let row = try JSONDecoder().decode(PerModelAggregate.self, from: json)
    #expect(row.avgQuality == nil)
    #expect(row.meanTtmSeconds == nil)
    #expect(row.dollarPerPr == nil)
}

// MARK: - <unknown> row decodes normally

@Test func modelsAnalyticsResponseDecodesUnknownModelRow() throws {
    let json = """
    {
      "model": "<unknown>",
      "podCount": 50,
      "completeCount": 30,
      "killedCount": 10,
      "failedCount": 10,
      "successRate": 0.6,
      "totalCostUsd": null,
      "dollarPerPr": null,
      "scoredCount": 20,
      "avgQuality": 65.0,
      "meanTtmSeconds": 1200.0,
      "escalatedCount": 5,
      "escalationRate": 0.1,
      "completeCostUsd": null
    }
    """.data(using: .utf8)!
    let row = try JSONDecoder().decode(PerModelAggregate.self, from: json)
    #expect(row.model == "<unknown>")
    #expect(row.podCount == 50)
    #expect(abs((row.avgQuality ?? 0) - 65.0) < 0.001)
}

// MARK: - Snake-case key strategy matches rest of AutopodClient (no conversion)

@Test func modelsAnalyticsResponseUsesDefaultKeyStrategy() throws {
    // The daemon sends camelCase; JSONDecoder() with no key strategy decodes it correctly.
    let json = """
    {
      "cheapestDollarPerPrModel": "claude-haiku-4-5",
      "cheapestDollarPerPr": 0.10,
      "bestQualityModel": "claude-opus-4-7",
      "bestQuality": 90.0,
      "mostUsedModel": "claude-sonnet-4-6",
      "mostUsedPodCount": 100,
      "cohortSize": 150,
      "mostUsedDailySparkline": [{"day":"2026-04-12","count":5}],
      "cheapestDollarPerPrDelta": {"value": -0.02, "direction": "down"}
    }
    """.data(using: .utf8)!
    let summary = try JSONDecoder().decode(ModelsSummary.self, from: json)
    #expect(summary.cheapestDollarPerPrModel == "claude-haiku-4-5")
    #expect(summary.mostUsedPodCount == 100)
    #expect(summary.cheapestDollarPerPrDelta.value < 0)
}

// MARK: - Direction enum: up / down / flat

@Test func modelsDollarDeltaDirectionDecodesAllCases() throws {
    let cases: [(String, ModelsDollarDelta.Direction)] = [
        ("up", .up), ("down", .down), ("flat", .flat),
    ]
    for (raw, expected) in cases {
        let json = #"{"value":0.0,"direction":"\#(raw)"}"#.data(using: .utf8)!
        let delta = try JSONDecoder().decode(ModelsDollarDelta.self, from: json)
        #expect(delta.direction == expected)
    }
}

// MARK: - Stage label decode: all 8 byte-for-byte

@Test func modelsFailureStageCellStageLabelsDecodeCorrectly() throws {
    let stages = ["build", "health", "smoke", "test", "lint", "sast", "facts", "taskReview"]
    for rawStage in stages {
        let json = """
        {"stage":"\(rawStage)","podsRan":10,"podsFailed":2,"failureRate":0.2}
        """.data(using: .utf8)!
        let cell = try JSONDecoder().decode(StageFailureRow.self, from: json)
        #expect(cell.stage.rawValue == rawStage)
    }
}

// MARK: - Runtime enum: claude / codex / copilot; length == 3

@Test func modelsRuntimeKindDecodesAllCases() throws {
    let json = makeFullModelsFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(ModelsAnalyticsResponse.self, from: json)

    #expect(response.byRuntime.count == 3)
    #expect(response.byRuntime[0].runtime == .claude)
    #expect(response.byRuntime[1].runtime == .codex)
    #expect(response.byRuntime[2].runtime == .copilot)
}

// MARK: - Helpers

private func makeModelsSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: _modelsFixedDate)!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        return #"{"day":"\#(fmt.string(from: date))","count":\#(i % 10)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

private func makeFullModelsFixtureJSON() -> String {
    let allZeroStages = """
    [
      {"stage":"build","podsRan":150,"podsFailed":10,"failureRate":0.067},
      {"stage":"health","podsRan":140,"podsFailed":5,"failureRate":0.036},
      {"stage":"smoke","podsRan":135,"podsFailed":8,"failureRate":0.059},
      {"stage":"test","podsRan":130,"podsFailed":20,"failureRate":0.154},
      {"stage":"lint","podsRan":125,"podsFailed":3,"failureRate":0.024},
      {"stage":"sast","podsRan":120,"podsFailed":1,"failureRate":0.008},
      {"stage":"facts","podsRan":0,"podsFailed":0,"failureRate":0.0},
      {"stage":"taskReview","podsRan":0,"podsFailed":0,"failureRate":0.0}
    ]
    """
    return """
    {
      "summary": {
        "cheapestDollarPerPrModel": "claude-haiku-4-5",
        "cheapestDollarPerPr": 0.42,
        "bestQualityModel": "claude-opus-4-7",
        "bestQuality": 88.0,
        "mostUsedModel": "claude-sonnet-4-6",
        "mostUsedPodCount": 200,
        "cohortSize": 350,
        "mostUsedDailySparkline": \(makeModelsSparklineJSON(days: 30)),
        "cheapestDollarPerPrDelta": {"value": -0.05, "direction": "down"}
      },
      "byModel": [
        {
          "model": "claude-sonnet-4-6",
          "podCount": 200,
          "completeCount": 160,
          "killedCount": 20,
          "failedCount": 20,
          "successRate": 0.8,
          "totalCostUsd": 84.0,
          "dollarPerPr": 0.525,
          "scoredCount": 120,
          "avgQuality": 78.5,
          "meanTtmSeconds": 3600.0,
          "escalatedCount": 30,
          "escalationRate": 0.15,
          "completeCostUsd": 67.2
        },
        {
          "model": "<unknown>",
          "podCount": 50,
          "completeCount": 30,
          "killedCount": 10,
          "failedCount": 10,
          "successRate": 0.6,
          "totalCostUsd": null,
          "dollarPerPr": null,
          "scoredCount": 20,
          "avgQuality": 65.0,
          "meanTtmSeconds": 1800.0,
          "escalatedCount": 8,
          "escalationRate": 0.16,
          "completeCostUsd": null
        }
      ],
      "byRuntime": [
        {
          "runtime": "claude",
          "podCount": 300,
          "completeCount": 240,
          "killedCount": 30,
          "failedCount": 30,
          "successRate": 0.8,
          "totalCostUsd": 126.0,
          "dollarPerPr": 0.525,
          "scoredCount": 200,
          "avgQuality": 79.0,
          "meanTtmSeconds": 3500.0,
          "escalatedCount": 45,
          "escalationRate": 0.15
        },
        {
          "runtime": "codex",
          "podCount": 50,
          "completeCount": 35,
          "killedCount": 10,
          "failedCount": 5,
          "successRate": 0.7,
          "totalCostUsd": 21.0,
          "dollarPerPr": 0.6,
          "scoredCount": 30,
          "avgQuality": 72.0,
          "meanTtmSeconds": 4000.0,
          "escalatedCount": 10,
          "escalationRate": 0.2
        },
        {
          "runtime": "copilot",
          "podCount": 0,
          "completeCount": 0,
          "killedCount": 0,
          "failedCount": 0,
          "successRate": 0.0,
          "totalCostUsd": 0.0,
          "dollarPerPr": null,
          "scoredCount": 0,
          "avgQuality": null,
          "meanTtmSeconds": null,
          "escalatedCount": 0,
          "escalationRate": 0.0
        }
      ],
      "failureStageMatrix": [
        {
          "model": "claude-sonnet-4-6",
          "stages": \(allZeroStages)
        }
      ],
      "unknownModels": [
        {"rawModel": "gpt-unknown-v1", "podCount": 50}
      ]
    }
    """
}

private func makeMinimalModelsFixtureJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: _modelsFixedDate)!
    let sparkline = (0..<days).map { i -> String in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        return #"{"day":"\#(fmt.string(from: date))","count":0}"#
    }.joined(separator: ",")

    return """
    {
      "summary": {
        "cheapestDollarPerPrModel": null,
        "cheapestDollarPerPr": null,
        "bestQualityModel": null,
        "bestQuality": null,
        "mostUsedModel": null,
        "mostUsedPodCount": null,
        "cohortSize": 0,
        "mostUsedDailySparkline": [\(sparkline)],
        "cheapestDollarPerPrDelta": {"value": 0.0, "direction": "flat"}
      },
      "byModel": [],
      "byRuntime": [
        {"runtime":"claude","podCount":0,"completeCount":0,"killedCount":0,"failedCount":0,"successRate":0.0,"totalCostUsd":0.0,"dollarPerPr":null,"scoredCount":0,"avgQuality":null,"meanTtmSeconds":null,"escalatedCount":0,"escalationRate":0.0},
        {"runtime":"codex","podCount":0,"completeCount":0,"killedCount":0,"failedCount":0,"successRate":0.0,"totalCostUsd":0.0,"dollarPerPr":null,"scoredCount":0,"avgQuality":null,"meanTtmSeconds":null,"escalatedCount":0,"escalationRate":0.0},
        {"runtime":"copilot","podCount":0,"completeCount":0,"killedCount":0,"failedCount":0,"successRate":0.0,"totalCostUsd":0.0,"dollarPerPr":null,"scoredCount":0,"avgQuality":null,"meanTtmSeconds":null,"escalatedCount":0,"escalationRate":0.0}
      ],
      "failureStageMatrix": [],
      "unknownModels": []
    }
    """
}

private let _modelsFixedDate: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 5; c.day = 11
    return Calendar(identifier: .gregorian).date(from: c)!
}()
