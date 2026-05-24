import Testing
@testable import AutopodUI
@testable import AutopodClient

// MARK: - Fixture helper

private func makeBox(
    _ status: LoadBearingStatus,
    p25: Double = 0, p50: Double = 0, p75: Double = 0, p90: Double = 0,
    max: Double = 0, sampleCount: Int = 0
) -> TimeInStatusBox {
    TimeInStatusBox(status: status, p25: p25, p50: p50, p75: p75, p90: p90, max: max, sampleCount: sampleCount)
}

// MARK: - Outlier cap

@Test func outlierCapClipsHourLongMaxValues() {
    // p90s in minutes (≤300s); max values in hours (43200s = 12h, 7200s = 2h).
    // coreUpper = max(60,120,200,300, 30,60,120,240) = 300
    // outlierThreshold = max(300×1.25, 300+60, 1) = max(375, 360, 1) = 375
    // fullUpper = 43200 > 375 → displayCap = 375
    let boxes = [
        makeBox(.queued,   p25: 60, p50: 120, p75: 200, p90: 300, max: 43200, sampleCount: 50),
        makeBox(.running,  p25: 30, p50: 60,  p75: 120, p90: 240, max: 7200,  sampleCount: 50),
    ]
    let data = prepareTimeInStatusDisplay(boxes)

    #expect(data.displayCap < 43200)
    #expect(data.displayCap < 7200)

    for row in data.rows where row.source.sampleCount > 0 {
        // Core percentiles are below the cap — must not be clamped.
        #expect(row.displayP25 == row.source.p25)
        #expect(row.displayP50 == row.source.p50)
        #expect(row.displayP75 == row.source.p75)
        #expect(row.displayP90 == row.source.p90)
        // Max is above the cap — must be clamped and flagged.
        #expect(row.isMaxClipped == true)
        #expect(row.displayMax == data.displayCap)
    }
}

// MARK: - No false clipping

@Test func noFalseClippingWhenMaxWithinThreshold() {
    // coreUpper = 300, outlierThreshold = 375, fullUpper = 360 ≤ 375
    // → displayCap = max(360, 1) = 360; no row should be clipped.
    let boxes = [
        makeBox(.queued, p25: 60, p50: 120, p75: 200, p90: 300, max: 360, sampleCount: 50),
    ]
    let data = prepareTimeInStatusDisplay(boxes)

    #expect(data.displayCap >= 360)
    #expect(data.rows.allSatisfy { !$0.isMaxClipped })
}

// MARK: - Zero samples

@Test func zeroSampleRowDoesNotInfluenceCap() {
    // Only the queued row is non-empty; running has sampleCount=0.
    // The running row's max=0 must not pull the cap down or be marked clipped.
    let boxes = [
        makeBox(.queued,  p25: 60, p50: 120, p75: 200, p90: 300, max: 43200, sampleCount: 50),
        makeBox(.running, sampleCount: 0),
    ]
    let data = prepareTimeInStatusDisplay(boxes)

    // Cap is derived from the queued row only — hour-long max must be clipped.
    #expect(data.displayCap < 43200)

    // Zero-sample row must not be marked clipped and must have zero display values.
    let runningRow = data.rows.first { $0.source.status == .running }!
    #expect(runningRow.isMaxClipped == false)
    #expect(runningRow.displayMax == 0)
}

// MARK: - All empty

@Test func allEmptyPayloadYieldsSafePositiveCap() {
    // All boxes have sampleCount == 0 — the guard path returns displayCap = 1.
    let boxes = LoadBearingStatus.allCases.map { makeBox($0, sampleCount: 0) }
    let data = prepareTimeInStatusDisplay(boxes)

    #expect(data.displayCap >= 1)
    #expect(data.rows.allSatisfy { !$0.isMaxClipped })
}
