import Foundation
import AutopodClient

/// Fictional, offline response fixtures for the isolated Preview and owned-view renders.
@MainActor enum DesktopAnalyticsFixtures {
  @MainActor private enum Reliability {
static func makeSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")

    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: Date())!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        let rate = String(format: "%.4f", Double(i) / Double(days))
        return #"{"day":"\#(day)","rate":\#(rate)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

static func makeFullFixtureJSON() -> String {
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
                "podId": "cleanup-demo",
                "profile": "backend",
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
          "profile": "backend",
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
  }
  @MainActor private enum Quality {
static func makeSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")

    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: Date())!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        let avgScore = String(format: "%.1f", 60.0 + Double(i))
        return #"{"day":"\#(day)","avgScore":\#(avgScore),"podCount":2}"#
    }
    return "[\(points.joined(separator: ","))]"
}

static func makeDistributionJSON() -> String {
    let labels = ["0-9","10-19","20-29","30-39","40-49","50-59","60-69","70-79","80-89","90-100"]
    let buckets = labels.enumerated().map { i, label in
        #"{"bucket":"\#(label)","count":\#(i)}"#
    }
    return "[\(buckets.joined(separator: ","))]"
}

static func makeFullFixtureJSON(days: Int) -> String {
    let scoreA = """
    {
      "podId": "retry-demoabbccdd",
      "score": 85,
      "algorithmVersion": 2, "inspectionAvailability": "available",
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
      "algorithmVersion": 2, "inspectionAvailability": "available",
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
        "algorithmVersion": 3,
        "totalPodsScored": 45,
        "legacyRowsExcluded": 12,
        "unavailableRows": 4,
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


  }
  @MainActor private enum Safety {
static func makeFullSafetyFixtureJSON() -> String {
    let sparkline = makeSafetySparklineJSON(days: 30)
    return """
    {
      "summary": {
        "totalEvents": 127,
        "byKind": { "pii": 80, "injection": 47 },
        "quarantineCount": 30,
        "quarantineHighRiskCount": 5,
        "sparkline": \(sparkline),
        "deltaVsPrior": { "value": 15, "direction": "up" }
      },
      "byPattern": [
        { "kind": "pii",       "patternName": "email",              "count": 40 },
        { "kind": "injection", "patternName": "direct-instruction", "count": 20 }
      ],
      "bySource": [
        { "source": "action_response", "count": 80 },
        { "source": "mcp_proxy",       "count": 47 }
      ],
      "firewallDenials": {
        "total": 12,
        "affectedPods": 3,
        "topHosts": [
          { "sni": "blocked.example.com", "count": 8, "lastDeniedAt": "2026-05-01T12:00:00Z" },
          { "sni": "other.example.com",   "count": 4, "lastDeniedAt": "2026-05-01T11:00:00Z" }
        ],
        "recent": [
          {
            "podId": "abc12345",
            "sni": "blocked.example.com",
            "src": "127.0.0.1",
            "deniedAt": "2026-05-01T12:00:00Z"
          }
        ]
      },
      "worktreeSafety": {
        "currentCompromisedPods": 1,
        "totalIncidents": 2,
        "recentIncidents": [
          {
            "podId": "abc12345",
            "deletionCount": 42,
            "threshold": 10,
            "detectedAt": "2026-05-01T12:00:00Z"
          }
        ]
      },
      "quarantineHistogram": [
        { "bucket": "0.0-0.1", "count": 100 },
        { "bucket": "0.1-0.2", "count": 20  },
        { "bucket": "0.2-0.3", "count": 10  },
        { "bucket": "0.3-0.4", "count": 5   },
        { "bucket": "0.4-0.5", "count": 3   },
        { "bucket": "0.5-0.6", "count": 2   },
        { "bucket": "0.6-0.7", "count": 2   },
        { "bucket": "0.7-0.8", "count": 1   },
        { "bucket": "0.8-0.9", "count": 1   },
        { "bucket": "0.9-1.0", "count": 1   }
      ],
      "byPod": [
        {
          "podId": "abc12345",
          "profile": "backend",
          "eventCount": 10,
          "lastEventAt": "2026-05-01T11:00:00Z",
          "topInjections": [
            {
              "patternName": "direct-instruction",
              "severity": 0.85,
              "payloadExcerpt": "ignore all previous instructions",
              "createdAt": "2026-05-01T11:00:00Z"
            }
          ]
        },
        {
          "podId": "__pre_creation__",
          "profile": null,
          "eventCount": 3,
          "lastEventAt": "2026-05-01T10:00:00Z",
          "topInjections": []
        }
      ],
      "networkPolicy": [
        { "bucket": "allow-all",   "count": 50 },
        { "bucket": "restricted",  "count": 30 },
        { "bucket": "deny-all",    "count": 10 },
        { "bucket": "unknown",     "count": 5  }
      ],
      "auditChain": {
        "lastVerifiedAt": "2026-05-01T12:00:00Z",
        "valid": true,
        "totalPods": 10,
        "totalEntries": 500,
        "firstMismatch": null
      }
    }
    """
}

static func makeSafetySparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: Date())!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        return #"{"day":"\#(day)","count":\#(i)}"#
    }
    return "[\(points.joined(separator: ","))]"
}
  }
  @MainActor private enum Throughput {
static func makeFullThroughputFixtureJSON() -> String {
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
          "profile": "backend",
          "status": "complete",
          "completedAt": "2026-05-09T14:32:00Z"
        },
        {
          "podId": "cleanup-demo",
          "profile": "webapp",
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



static func makeThroughputSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: Date())!
    let points = (0..<days).map { i -> String in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        return #"{"day":"\#(day)","count":\#(i % 5)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

static func _minimalSummaryJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let sparkline = (0..<days).map { i -> String in
        let base = Calendar.current.date(byAdding: .day, value: -(days - 1 - i), to: Date())!
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

static func _allZeroTimeInStatusJSON() -> String {
    let statuses = ["queued", "running", "validating", "awaiting_input"]
    let entries = statuses.map { s in
        """
        {"status":"\(s)","p25":0,"p50":0,"p75":0,"p90":0,"max":0,"sampleCount":0}
        """
    }.joined(separator: ",")
    return "[\(entries)]"
}

static func _fullTimeInStatusJSON() -> String {
    """
    [
      {"status":"queued","p25":60.0,"p50":120.0,"p75":240.0,"p90":360.0,"max":600.0,"sampleCount":10},
      {"status":"running","p25":300.0,"p50":600.0,"p75":1200.0,"p90":1800.0,"max":3600.0,"sampleCount":10},
      {"status":"validating","p25":30.0,"p50":60.0,"p75":90.0,"p90":120.0,"max":180.0,"sampleCount":8},
      {"status":"awaiting_input","p25":900.0,"p50":1800.0,"p75":3600.0,"p90":7200.0,"max":14400.0,"sampleCount":4}
    ]
    """
}
  }
  @MainActor private enum Escalations {
static let _escalationsDayFmt: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX"); return f
  }()
  static let _escalationBucketLabels = ["<1m", "1–5m", "5–15m", "15m–1h", "1–4h", "4–24h", "1–7d", ">7d"]
static func _escalationDay(offsetDays: Int) -> String {
    let target = Calendar.current.date(byAdding: .day, value: offsetDays, to: Date())!
    return _escalationsDayFmt.string(from: target)
}

static func makeFullEscalationsFixtureJSON() -> String {
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
        {"profile": "backend", "podCount": 60, "escalatedCount": 15, "rate": 0.25},
        {"profile": "webapp", "podCount": 32, "escalatedCount": 9, "rate": 0.28125},
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


  }
  @MainActor private enum Models {
static func makeModelsSparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: Date())!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        return #"{"day":"\#(fmt.string(from: date))","count":\#(i % 10)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

static func makeFullModelsFixtureJSON() -> String {
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
          "providerAttemptCount":240,"completedAttemptCount":220,"deliveredPrCount":160,
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
          "model": "Model B",
          "podCount": 50,
          "providerAttemptCount":60,"completedAttemptCount":55,"deliveredPrCount":25,
          "completeCount": 30,
          "killedCount": 10,
          "failedCount": 10,
          "successRate": 0.6,
          "totalCostUsd": 20.0,
          "dollarPerPr": 0.8,
          "scoredCount": 20,
          "avgQuality": 65.0,
          "meanTtmSeconds": 1800.0,
          "escalatedCount": 8,
          "escalationRate": 0.16,
          "completeCostUsd": 12.0
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
          "providerAttemptCount":60,"completedAttemptCount":55,"deliveredPrCount":25,
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
          "dollarPerPr": 0.8,
          "scoredCount": 0,
          "avgQuality": null,
          "meanTtmSeconds": null,
          "escalatedCount": 0,
          "escalationRate": 0.0
        },
        {
          "runtime": "pi",
          "podCount": 0,
          "completeCount": 0,
          "killedCount": 0,
          "failedCount": 0,
          "successRate": 0.0,
          "totalCostUsd": 0.0,
          "dollarPerPr": 0.8,
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


  }
  static func reliability(_ days: Int) throws -> ReliabilityAnalyticsResponse { try decode(ReliabilityAnalyticsResponse.self, Reliability.makeFullFixtureJSON(), days: days) }
  static func quality(_ days: Int) throws -> QualityAnalyticsResponse { try decode(QualityAnalyticsResponse.self, Quality.makeFullFixtureJSON(days: days), days: days) }
  static func safety(_ days: Int) throws -> SafetyAnalyticsResponse { try decode(SafetyAnalyticsResponse.self, Safety.makeFullSafetyFixtureJSON(), days: days) }
  static func throughput(_ days: Int) throws -> ThroughputAnalyticsResponse { try decode(ThroughputAnalyticsResponse.self, Throughput.makeFullThroughputFixtureJSON(), days: days) }
  static func escalations(_ days: Int) throws -> EscalationsAnalyticsResponse { try decode(EscalationsAnalyticsResponse.self, Escalations.makeFullEscalationsFixtureJSON(), days: days) }
  static func models(_ days: Int) throws -> ModelsAnalyticsResponse { try decode(ModelsAnalyticsResponse.self, Models.makeFullModelsFixtureJSON(), days: days) }
  static func cost(_ days: Int) throws -> CostAnalyticsResponse { try decode(CostAnalyticsResponse.self, #"{"total":42.75,"sparkline":[{"day":"2026-10-17","costUsd":4.2},{"day":"2026-10-18","costUsd":3.9}],"deltaVsPrior":{"value":-5.25,"direction":"down"},"byPhase":[{"phase":"agent_initial","costUsd":20},{"phase":"agent_rework_1","costUsd":8.5},{"phase":"review","costUsd":9.25},{"phase":"plan_eval","costUsd":3}],"byProfileModel":[{"profile":"backend","model":"Model A","costUsd":30,"podCount":5},{"profile":"webapp","model":"Model B","costUsd":12.75,"podCount":2}],"top10":[{"podId":"cleanup-demo","profile":"backend","model":"Model A","finalStatus":"failed","costUsd":2.16,"completedAt":"2026-10-18T10:00:00Z"},{"podId":"retry-demo","profile":"backend","model":"Model A","finalStatus":"validated","costUsd":1.84,"completedAt":"2026-10-18T10:00:00Z"},{"podId":"archived-fixture","profile":"backend","model":"Model B","finalStatus":"complete","costUsd":1.2,"completedAt":"2026-10-17T10:00:00Z","historyArchived":true}],"waste":{"total":3.5,"podCount":2},"telemetry":{"completeness":"partial","infrastructureCost":"unavailable","diagnostics":[{"podId":"archived-fixture","field":"phaseCost","code":"unavailable"}]},"costEvidence":{"basis":"stored","billingVerified":false,"knownEstimatedCostUsd":2.4,"unavailablePhaseCount":2,"conflictingPodCount":0,"diagnostics":[],"omittedDiagnosticCount":0}}"#, days: days) }
  static func memory(_ days: Int) throws -> MemoryAnalyticsResponse { try decode(MemoryAnalyticsResponse.self, #"{"days":30,"summary":{"selectedCount":62,"injectedCount":48,"readCount":39,"searchedCount":25,"appliedCount":31,"notApplicableCount":4,"harmfulStaleCount":1,"notReportedCount":9,"candidateCount":8,"approvedCandidateCount":5},"impact":{"cohortSize":18,"comparisonCohortSize":22,"qualityDelta":3.1,"validationFailureDelta":-0.1,"fixAttemptDelta":-0.2,"escalationDelta":-0.1,"costDeltaUsd":-0.42},"topMemories":[{"memoryId":"fixture-memory","path":"global/checkpoints.md","impactSummary":"Checkpoint guidance was reported as applied.","selectedCount":18,"injectedCount":15,"appliedCount":12,"harmfulStaleCount":0}]}"#, days: days) }
  static func verify() throws -> AuditChainVerifyResponse {
    try decode(AuditChainVerifyResponse.self, #"{"valid":true,"totalPods":10,"totalEntries":500,"firstMismatch":null,"ranAt":"2026-10-18T10:00:00Z"}"#, days: 30)
  }
  private static func decode<T: Decodable>(_ type: T.Type, _ json: String, days: Int) throws -> T {
    var object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    if object["days"] != nil { object["days"] = days }
    return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
  }
}
