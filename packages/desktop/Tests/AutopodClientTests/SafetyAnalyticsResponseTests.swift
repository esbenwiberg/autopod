import Foundation
import Testing
@testable import AutopodClient

// MARK: - Full round-trip

@Test func safetyAnalyticsResponseDecodesFullPayload() throws {
    let json = makeFullSafetyFixtureJSON().data(using: .utf8)!
    let response = try JSONDecoder().decode(SafetyAnalyticsResponse.self, from: json)

    // summary
    #expect(response.summary.totalEvents == 127)
    #expect(response.summary.byKind.pii == 80)
    #expect(response.summary.byKind.injection == 47)
    #expect(response.summary.quarantineCount == 30)
    #expect(response.summary.quarantineHighRiskCount == 5)
    #expect(response.summary.sparkline.count == 30)
    #expect(response.summary.deltaVsPrior.value == 15)
    #expect(response.summary.deltaVsPrior.direction == .up)

    // byPattern
    #expect(response.byPattern.count == 2)
    #expect(response.byPattern[0].kind == .pii)
    #expect(response.byPattern[0].patternName == "email")
    #expect(response.byPattern[0].count == 40)
    #expect(response.byPattern[1].kind == .injection)
    #expect(response.byPattern[1].patternName == "direct-instruction")
    #expect(response.byPattern[1].count == 20)

    // bySource
    #expect(response.bySource.count == 2)
    #expect(response.bySource[0].source == .actionResponse)
    #expect(response.bySource[0].count == 80)

    // quarantineHistogram — 10 buckets
    #expect(response.quarantineHistogram.count == 10)
    #expect(response.quarantineHistogram[0].bucket == "0.0-0.1")
    #expect(response.quarantineHistogram[9].bucket == "0.9-1.0")

    // byPod — real pod
    #expect(response.byPod.count == 2)
    let realPod = response.byPod[0]
    #expect(realPod.podId == "abc12345")
    #expect(realPod.profile == "my-profile")
    #expect(realPod.eventCount == 10)
    #expect(realPod.topInjections.count == 1)
    let inj = realPod.topInjections[0]
    #expect(inj.patternName == "direct-instruction")
    #expect(inj.severity == 0.85)
    #expect(inj.payloadExcerpt == "ignore all previous instructions")

    // byPod — __pre_creation__ entry
    let preCreation = response.byPod[1]
    #expect(preCreation.podId == "__pre_creation__")
    #expect(preCreation.profile == nil)
    #expect(preCreation.eventCount == 3)
    #expect(preCreation.topInjections.isEmpty)

    // networkPolicy
    #expect(response.networkPolicy.count == 4)
    #expect(response.networkPolicy[0].bucket == .allowAll)
    #expect(response.networkPolicy[0].count == 50)

    // auditChain — valid
    #expect(response.auditChain.lastVerifiedAt == "2026-05-01T12:00:00Z")
    #expect(response.auditChain.valid == true)
    #expect(response.auditChain.totalPods == 10)
    #expect(response.auditChain.totalEntries == 500)
    #expect(response.auditChain.firstMismatch == nil)
}

// MARK: - auditChain all-null shape

@Test func safetyAnalyticsAuditChainAllNullDecodes() throws {
    let json = """
    {
      "lastVerifiedAt": null,
      "valid": null,
      "totalPods": null,
      "totalEntries": null,
      "firstMismatch": null
    }
    """.data(using: .utf8)!
    let status = try JSONDecoder().decode(SafetyAuditChainStatus.self, from: json)
    #expect(status.lastVerifiedAt == nil)
    #expect(status.valid == nil)
    #expect(status.totalPods == nil)
    #expect(status.totalEntries == nil)
    #expect(status.firstMismatch == nil)
}

// MARK: - byPod __pre_creation__ decodes with profile nil

@Test func safetyByPodPreCreationDecodes() throws {
    let json = """
    {
      "podId": "__pre_creation__",
      "profile": null,
      "eventCount": 5,
      "lastEventAt": "2026-05-01T10:00:00Z",
      "topInjections": []
    }
    """.data(using: .utf8)!
    let entry = try JSONDecoder().decode(SafetyPodEntry.self, from: json)
    #expect(entry.podId == "__pre_creation__")
    #expect(entry.profile == nil)
    #expect(entry.eventCount == 5)
    #expect(entry.topInjections.isEmpty)
}

// MARK: - deltaVsPrior direction decodes all cases

@Test func safetyDeltaDirectionDecodesAllCases() throws {
    let cases: [(String, SafetyDelta.Direction)] = [
        ("up", .up),
        ("down", .down),
        ("flat", .flat),
    ]
    for (raw, expected) in cases {
        let json = #"{"value": 5, "direction": "\#(raw)"}"#.data(using: .utf8)!
        let delta = try JSONDecoder().decode(SafetyDelta.self, from: json)
        #expect(delta.direction == expected)
    }
}

// MARK: - SafetyEventKind decodes both cases

@Test func safetyEventKindDecodesBothCases() throws {
    let pii = try JSONDecoder().decode(SafetyEventKind.self, from: #""pii""#.data(using: .utf8)!)
    let injection = try JSONDecoder().decode(SafetyEventKind.self, from: #""injection""#.data(using: .utf8)!)
    #expect(pii == .pii)
    #expect(injection == .injection)
}

// MARK: - NetworkPolicyBucket decodes all cases

@Test func networkPolicyBucketDecodesAllCases() throws {
    let cases: [(String, NetworkPolicyBucket)] = [
        ("allow-all", .allowAll),
        ("restricted", .restricted),
        ("deny-all", .denyAll),
        ("unknown", .unknown),
    ]
    for (raw, expected) in cases {
        let json = "\"\(raw)\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(NetworkPolicyBucket.self, from: json)
        #expect(decoded == expected)
    }
}

// MARK: - SafetyEventSource decodes all cases

@Test func safetyEventSourceDecodesAllCases() throws {
    let cases: [(String, SafetyEventSource)] = [
        ("action_response", .actionResponse),
        ("mcp_proxy", .mcpProxy),
        ("issue_body", .issueBody),
        ("claude_md_section", .claudeMdSection),
        ("skill_content", .skillContent),
        ("pod_input", .podInput),
        ("event_payload", .eventPayload),
    ]
    for (raw, expected) in cases {
        let json = "\"\(raw)\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(SafetyEventSource.self, from: json)
        #expect(decoded == expected)
    }
}

// MARK: - AuditChainVerifyResponse decodes

@Test func auditChainVerifyResponseDecodesFullPayload() throws {
    let json = """
    {
      "valid": true,
      "totalPods": 12,
      "totalEntries": 600,
      "firstMismatch": null,
      "ranAt": "2026-05-01T15:00:00Z"
    }
    """.data(using: .utf8)!
    let response = try JSONDecoder().decode(AuditChainVerifyResponse.self, from: json)
    #expect(response.valid == true)
    #expect(response.totalPods == 12)
    #expect(response.totalEntries == 600)
    #expect(response.firstMismatch == nil)
    #expect(response.ranAt == "2026-05-01T15:00:00Z")
}

@Test func auditChainVerifyResponseDecodesWithMismatch() throws {
    let json = """
    {
      "valid": false,
      "totalPods": 5,
      "totalEntries": 200,
      "firstMismatch": { "podId": "badpod1", "rowId": 42, "reason": "hash mismatch" },
      "ranAt": "2026-05-02T08:00:00Z"
    }
    """.data(using: .utf8)!
    let response = try JSONDecoder().decode(AuditChainVerifyResponse.self, from: json)
    #expect(response.valid == false)
    #expect(response.firstMismatch?.podId == "badpod1")
    #expect(response.firstMismatch?.rowId == 42)
    #expect(response.firstMismatch?.reason == "hash mismatch")
}

// MARK: - Injection severity nil (PII rows)

@Test func safetyInjectionEntrySeverityNilDecodes() throws {
    let json = """
    {
      "patternName": "email",
      "severity": null,
      "payloadExcerpt": "test@example.com",
      "createdAt": "2026-05-01T09:00:00Z"
    }
    """.data(using: .utf8)!
    let entry = try JSONDecoder().decode(SafetyInjectionEntry.self, from: json)
    #expect(entry.severity == nil)
    #expect(entry.patternName == "email")
}

// MARK: - Fixture builder

private func makeFullSafetyFixtureJSON() -> String {
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
          "profile": "my-profile",
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

private func makeSafetySparklineJSON(days: Int) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "yyyy-MM-dd"
    fmt.locale = Locale(identifier: "en_US_POSIX")
    let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: _safetyFixedDate)!
    let points: [String] = (0..<days).map { i in
        let date = Calendar.current.date(byAdding: .day, value: i, to: start)!
        let day = fmt.string(from: date)
        return #"{"day":"\#(day)","count":\#(i)}"#
    }
    return "[\(points.joined(separator: ","))]"
}

private let _safetyFixedDate: Date = {
    var c = DateComponents()
    c.year = 2026; c.month = 5; c.day = 1
    return Calendar(identifier: .gregorian).date(from: c)!
}()
