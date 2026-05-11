import Testing
@testable import AutopodUI
@testable import AutopodClient

// MARK: - Helpers

// Builds a minimal PerModelAggregate for simulator tests.
// Uses @testable import AutopodClient to reach the internal memberwise initializer.
private func makeModel(
    _ name: String,
    podCount: Int = 10,
    completeCount: Int = 10,
    successRate: Double = 1.0,
    totalCostUsd: Double? = nil,
    dollarPerPr: Double? = nil,
    scoredCount: Int = 0,
    avgQuality: Double? = nil,
    meanTtmSeconds: Double? = nil,
    escalationRate: Double = 0,
    completeCostUsd: Double? = nil
) -> PerModelAggregate {
    PerModelAggregate(
        model: name,
        podCount: podCount,
        completeCount: completeCount,
        killedCount: 0,
        failedCount: 0,
        successRate: successRate,
        totalCostUsd: totalCostUsd,
        dollarPerPr: dollarPerPr,
        scoredCount: scoredCount,
        avgQuality: avgQuality,
        meanTtmSeconds: meanTtmSeconds,
        escalatedCount: 0,
        escalationRate: escalationRate,
        completeCostUsd: completeCostUsd
    )
}

// MARK: - Zero-redirect identity

@Test func zeroRedirectIdentity() {
    // Fixture chosen so all per-axis values are exact in Double arithmetic.
    let opus = makeModel("claude-opus-4-7", podCount: 8, completeCount: 8,
                         successRate: 1.0, totalCostUsd: 40, dollarPerPr: 5.0,
                         scoredCount: 8, avgQuality: 80, meanTtmSeconds: 600, escalationRate: 0.25)
    let haiku = makeModel("claude-haiku-4-5", podCount: 8, completeCount: 8,
                          successRate: 1.0, totalCostUsd: 4, dollarPerPr: 0.5,
                          scoredCount: 8, avgQuality: 60, meanTtmSeconds: 300, escalationRate: 0.125)
    let byModel = [opus, haiku]

    // At 0%: no redirect happens — result is the fleet-wide baseline.
    // Exact Double equality is fine here because the short-circuit avoids
    // recomputing totalCostUsd from dollarPerPr (no floating-point drift).
    let result = projectFleet(byModel: byModel, source: opus, target: haiku, redirectFraction: 0)

    // Hand-computed expected values (all exact in IEEE 754 for these fixture values):
    //   $/PR       = (40+4)/(8+8) = 44/16 = 2.75
    //   quality    = (8×80+8×60)/16 = 1120/16 = 70
    //   successRate= (8×1+8×1)/16 = 1.0
    //   TTM        = (8×600+8×300)/16 = 7200/16 = 450
    //   escalation = (8×0.25+8×0.125)/16 = 3/16 = 0.1875
    let expected = SimulatedFleet(
        dollarPerPr: 2.75,
        avgQuality: 70.0,
        successRate: 1.0,
        meanTtmSeconds: 450.0,
        escalationRate: 0.1875
    )
    #expect(result == expected)
}

// MARK: - Full redirect math ($/PR)

@Test func fullRedirectDollarPerPr() {
    // Opus: 10 pods, 10 complete, totalCostUsd=50, dollarPerPr=5.0
    // Haiku: 10 pods, 10 complete, totalCostUsd=5, dollarPerPr=0.5
    // Fleet current $/PR = (50+5)/(10+10) = 2.75
    // Redirect 100% Opus→Haiku:
    //   source'.completeCount=0, target'.completeCount=20
    //   source'.cost=0, target'.cost=0.5×20=10
    //   Projected $/PR = 10/20 = 0.5
    let opus = makeModel("claude-opus-4-7", podCount: 10, completeCount: 10,
                         totalCostUsd: 50, dollarPerPr: 5.0)
    let haiku = makeModel("claude-haiku-4-5", podCount: 10, completeCount: 10,
                          totalCostUsd: 5, dollarPerPr: 0.5)

    let result = projectFleet(byModel: [opus, haiku], source: opus, target: haiku, redirectFraction: 1.0)

    #expect(abs((result.dollarPerPr ?? -1) - 0.5) < 0.001)
}

// MARK: - Partial redirect math ($/PR)

@Test func partialRedirectDollarPerPr() {
    // Same fixture, fraction=0.5 → 5 Opus pods → Haiku
    // source'.completeCount=5, target'.completeCount=15
    // source'.cost = 5×5 = 25, target'.cost = 0.5×15 = 7.5
    // Projected $/PR = (25+7.5)/(5+15) = 1.625
    let opus = makeModel("claude-opus-4-7", podCount: 10, completeCount: 10,
                         totalCostUsd: 50, dollarPerPr: 5.0)
    let haiku = makeModel("claude-haiku-4-5", podCount: 10, completeCount: 10,
                          totalCostUsd: 5, dollarPerPr: 0.5)

    let result = projectFleet(byModel: [opus, haiku], source: opus, target: haiku, redirectFraction: 0.5)

    #expect(abs((result.dollarPerPr ?? -1) - 1.625) < 0.001)
}

// MARK: - Success rate weighted by podCount

@Test func successRateWeightedByPodCount() {
    // Opus: podCount=10, successRate=0.9
    // Haiku: podCount=10, successRate=0.5
    // Current fleet = (10×0.9 + 10×0.5)/20 = 0.7
    // Redirect 50% Opus→Haiku:
    //   source'.podCount=5, target'.podCount=15
    //   Projected = (5×0.9 + 15×0.5)/20 = (4.5+7.5)/20 = 0.6
    let opus = makeModel("claude-opus-4-7", podCount: 10, completeCount: 9,
                         successRate: 0.9, totalCostUsd: 10, dollarPerPr: 1.0)
    let haiku = makeModel("claude-haiku-4-5", podCount: 10, completeCount: 5,
                          successRate: 0.5, totalCostUsd: 5, dollarPerPr: 1.0)

    let result = projectFleet(byModel: [opus, haiku], source: opus, target: haiku, redirectFraction: 0.5)

    #expect(abs(result.successRate - 0.6) < 0.001)
}

// MARK: - TTM null on target

@Test func ttmNullOnTargetContributesNothing() {
    // Opus: completeCount=10, meanTtmSeconds=600
    // Haiku: completeCount=0, meanTtmSeconds=nil (no complete pods)
    // Redirect 50% Opus→Haiku:
    //   srcComplete=5, tgtComplete=5
    //   Haiku meanTtmSeconds=nil → target slice contributes nothing
    //   Projected TTM = (600×5) / 5 = 600 (only Opus remaining contributes)
    let opus = makeModel("claude-opus-4-7", podCount: 10, completeCount: 10,
                         successRate: 1.0, totalCostUsd: 10, dollarPerPr: 1.0, meanTtmSeconds: 600)
    let haiku = makeModel("claude-haiku-4-5", podCount: 10, completeCount: 0,
                          successRate: 0.0, totalCostUsd: nil, dollarPerPr: nil, meanTtmSeconds: nil)

    let result = projectFleet(byModel: [opus, haiku], source: opus, target: haiku, redirectFraction: 0.5)

    #expect(abs((result.meanTtmSeconds ?? -1) - 600) < 0.001)
}

// MARK: - Quality null on target

@Test func qualityNullOnTargetYieldsNilProjected() {
    // Opus: scoredCount=10, avgQuality=80
    // Haiku: scoredCount=0, avgQuality=nil (no quality rows)
    // Redirect 100% Opus→Haiku:
    //   srcScored=0 (no Opus scored pods remain)
    //   tgtScored=10 (but Haiku.avgQuality=nil → contributes nothing)
    //   Projected quality = nil (no rows contribute to the weighted average)
    let opus = makeModel("claude-opus-4-7", podCount: 10, completeCount: 10,
                         successRate: 1.0, totalCostUsd: 10, dollarPerPr: 1.0,
                         scoredCount: 10, avgQuality: 80)
    let haiku = makeModel("claude-haiku-4-5", podCount: 10, completeCount: 10,
                          successRate: 1.0, totalCostUsd: 5, dollarPerPr: 0.5,
                          scoredCount: 0, avgQuality: nil)

    let result = projectFleet(byModel: [opus, haiku], source: opus, target: haiku, redirectFraction: 1.0)

    #expect(result.avgQuality == nil)
}

// MARK: - <unknown> excluded from baseline

@Test func unknownModelExcludedFromBaseline() {
    // Fixture from the brief: Opus (eligible) + <unknown> (not eligible, nil cost).
    let opus = makeModel("claude-opus-4-7", podCount: 10, completeCount: 10,
                         successRate: 1.0, totalCostUsd: 50, dollarPerPr: 5.0)
    let unknown = makeModel("<unknown>", podCount: 10, totalCostUsd: nil, dollarPerPr: nil)

    // The eligible filter strips <unknown>; from the brief's two-model fixture, only Opus qualifies.
    let eligibleFromBriefFixture = [opus, unknown].filter { $0.isSimulatorEligible }
    #expect(eligibleFromBriefFixture.count == 1)

    // projectFleet requires source.model != target.model; add a second priced model.
    // At 0% redirect the projection equals the fleet baseline (no redirect applied).
    // The <unknown> row carries nil totalCostUsd and is skipped in the $/PR numerator.
    // Baseline $/PR = (50 + 2.5) / (10 + 5) = 3.5; <unknown>'s 10 pods don't inflate it.
    let haiku = makeModel("claude-haiku-4-5", podCount: 5, completeCount: 5,
                          successRate: 1.0, totalCostUsd: 2.5, dollarPerPr: 0.5)
    let result = projectFleet(byModel: [opus, unknown, haiku], source: opus, target: haiku, redirectFraction: 0)
    #expect(abs((result.dollarPerPr ?? -1) - 3.5) < 0.001)
}

// MARK: - Escalation rate weighted by podCount

@Test func escalationRateWeightedByPodCount() {
    // Opus: podCount=10, escalationRate=0.3
    // Haiku: podCount=10, escalationRate=0.1
    // Current = (10×0.3 + 10×0.1)/20 = 0.2
    // Redirect 50% Opus→Haiku:
    //   srcPods=5, tgtPods=15
    //   Projected = (5×0.3 + 15×0.1)/20 = (1.5+1.5)/20 = 0.15
    let opus = makeModel("claude-opus-4-7", podCount: 10, completeCount: 9,
                         successRate: 0.9, totalCostUsd: 10, dollarPerPr: 1.0,
                         escalationRate: 0.3)
    let haiku = makeModel("claude-haiku-4-5", podCount: 10, completeCount: 9,
                          successRate: 0.9, totalCostUsd: 5, dollarPerPr: 0.556,
                          escalationRate: 0.1)

    let result = projectFleet(byModel: [opus, haiku], source: opus, target: haiku, redirectFraction: 0.5)

    #expect(abs(result.escalationRate - 0.15) < 0.001)
}

// MARK: - Three-model fleet (third model unaffected)

@Test func threeModelFleetHaikuUnchanged() {
    // Redirect 30% Opus→Sonnet; verify Haiku's contribution to all 5 axes is unchanged.
    let opus = makeModel("claude-opus-4-7", podCount: 20, completeCount: 18,
                         successRate: 0.9, totalCostUsd: 90, dollarPerPr: 5.0,
                         scoredCount: 15, avgQuality: 88, meanTtmSeconds: 600, escalationRate: 0.1)
    let sonnet = makeModel("claude-sonnet-4-6", podCount: 30, completeCount: 25,
                           successRate: 0.833, totalCostUsd: 12.5, dollarPerPr: 0.5,
                           scoredCount: 20, avgQuality: 80, meanTtmSeconds: 400, escalationRate: 0.067)
    let haiku = makeModel("claude-haiku-4-5", podCount: 10, completeCount: 8,
                          successRate: 0.8, totalCostUsd: 2, dollarPerPr: 0.25,
                          scoredCount: 6, avgQuality: 70, meanTtmSeconds: 200, escalationRate: 0.05)

    let projected = projectFleet(byModel: [opus, sonnet, haiku], source: opus, target: sonnet, redirectFraction: 0.3)

    // redirected        = floor(20×0.3) = 6   → src': podCount=14,  tgt': podCount=36
    // redirectedComplete = floor(18×0.3) = 5   → src': completeCount=13, tgt': completeCount=30
    // redirectedScored  = floor(15×0.3) = 4   → src': scoredCount=11, tgt': scoredCount=24
    // haiku: podCount=10, completeCount=8, scoredCount=6 — UNCHANGED in all 5 axes.
    // Total pods conserved: 14+36+10 = 60.

    // Success rate (weight: podCount):
    //   (14×0.9  + 36×0.833 + 10×0.8) / 60
    //    ^^^Opus^^^  ^^^Sonnet^^^  ^^^Haiku unchanged^^^
    let expectedSuccessRate = (14.0 * 0.9 + 36.0 * 0.833 + 10.0 * 0.8) / 60.0
    #expect(abs(projected.successRate - expectedSuccessRate) < 0.001)

    // Escalation rate (weight: podCount):
    //   (14×0.1 + 36×0.067 + 10×0.05) / 60
    let expectedEscalationRate = (14.0 * 0.1 + 36.0 * 0.067 + 10.0 * 0.05) / 60.0
    #expect(abs(projected.escalationRate - expectedEscalationRate) < 0.001)

    // $/PR (weight: completeCount; src/tgt use dollarPerPr×count; others use totalCostUsd):
    //   (5.0×13 + 0.5×30 + 2) / (13+30+8) = 82/51
    //    ^^^Opus^^^  ^^^Sonnet^^^  ^^^Haiku: totalCostUsd=2, completeCount=8 unchanged^^^
    let expectedDollarPerPr = (5.0 * 13.0 + 0.5 * 30.0 + 2.0) / (13.0 + 30.0 + 8.0)
    #expect(abs((projected.dollarPerPr ?? -1) - expectedDollarPerPr) < 0.001)

    // Avg quality (weight: scoredCount):
    //   (11×88 + 24×80 + 6×70) / (11+24+6) = 3308/41
    //    ^^^Opus^^^  ^^^Sonnet^^^  ^^^Haiku: scoredCount=6 unchanged^^^
    let expectedAvgQuality = (11.0 * 88.0 + 24.0 * 80.0 + 6.0 * 70.0) / (11.0 + 24.0 + 6.0)
    #expect(abs((projected.avgQuality ?? -1) - expectedAvgQuality) < 0.001)

    // Mean TTM (weight: completeCount):
    //   (13×600 + 30×400 + 8×200) / (13+30+8) = 21400/51
    //    ^^^Opus^^^  ^^^Sonnet^^^  ^^^Haiku: completeCount=8 unchanged^^^
    let expectedMeanTtm = (13.0 * 600.0 + 30.0 * 400.0 + 8.0 * 200.0) / (13.0 + 30.0 + 8.0)
    #expect(abs((projected.meanTtmSeconds ?? -1) - expectedMeanTtm) < 0.001)
}
