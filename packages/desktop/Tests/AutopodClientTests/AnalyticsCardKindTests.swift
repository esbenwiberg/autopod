import Testing
@testable import AutopodUI

// MARK: - AnalyticsCardKind

@Test func analyticsCardKindRawValues() {
    #expect(AnalyticsCardKind.cost.rawValue == "cost")
    #expect(AnalyticsCardKind.quality.rawValue == "quality")
    #expect(AnalyticsCardKind.status.rawValue == "status")
    #expect(AnalyticsCardKind.memory.rawValue == "memory")
}

@Test func analyticsCardKindHashableRoundTrip() {
    var set: Set<AnalyticsCardKind> = []
    set.insert(.cost)
    set.insert(.quality)
    set.insert(.status)
    set.insert(.memory)
    #expect(set.contains(.cost))
    #expect(set.contains(.quality))
    #expect(set.contains(.status))
    #expect(set.contains(.memory))
    #expect(set.count == 4)
}
