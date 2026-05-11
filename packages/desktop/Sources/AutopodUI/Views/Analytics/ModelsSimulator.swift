import AutopodClient
import Foundation

// MARK: - Eligibility helpers

/// Raw string the daemon emits for pods whose model string didn't resolve via MODEL_CANONICAL.
let unknownModelKey = "<unknown>"

extension PerModelAggregate {
    /// True for models that can participate in the simulator: priced (non-<unknown>) with
    /// at least one historical pod to project from.
    var isSimulatorEligible: Bool { model != unknownModelKey && podCount > 0 }
}

// MARK: - Output

/// Fleet-wide aggregates produced by the what-if simulator after a modelled redirect.
public struct SimulatedFleet: Equatable {
    public let dollarPerPr: Double?
    public let avgQuality: Double?
    public let successRate: Double
    public let meanTtmSeconds: Double?
    public let escalationRate: Double
}

// MARK: - Main projection

/// Project fleet aggregates if `redirectFraction` of `source`'s terminal-cohort pods
/// had run on `target` instead.
///
/// Naïve assumption: redirected pods inherit `target`'s historical per-pod averages,
/// weighted by the redirected podCount. See ADR-023 for the accepted trade-off.
///
/// - byModel: full byModel array from the endpoint (may include `<unknown>` rows).
///   `<unknown>` rows are excluded internally — we can't price unresolved model strings.
/// - source / target: rows from byModel; source.model must differ from target.model.
/// - redirectFraction: 0..1 inclusive. 0 = no change; 1 = redirect all source pods.
public func projectFleet(
    byModel: [PerModelAggregate],
    source: PerModelAggregate,
    target: PerModelAggregate,
    redirectFraction: Double
) -> SimulatedFleet {
    let eligible = byModel.filter(\.isSimulatorEligible)

    guard !eligible.isEmpty else { return .empty }

    // Short-circuit at 0%: result equals the baseline exactly, with no floating-point
    // recomputation of totalCostUsd from dollarPerPr (avoids precision drift).
    if redirectFraction == 0 {
        return fleetBaseline(eligible)
    }

    // floor: conservative — a 30% redirect of 7 pods becomes 2, not 3.
    let redirected = Int(floor(Double(source.podCount) * redirectFraction))
    let redirectedComplete = Int(floor(Double(source.completeCount) * redirectFraction))
    let redirectedScored = Int(floor(Double(source.scoredCount) * redirectFraction))

    let srcPods = source.podCount - redirected
    let tgtPods = target.podCount + redirected
    let srcComplete = source.completeCount - redirectedComplete
    let tgtComplete = target.completeCount + redirectedComplete
    let srcScored = source.scoredCount - redirectedScored
    let tgtScored = target.scoredCount + redirectedScored

    // $/PR — weight by completeCount, not podCount.
    // Virtual totalCostUsd = dollarPerPr × newCompleteCount for source' and target'.
    // If either eligible model has null dollarPerPr (shouldn't happen; eligible strips <unknown>),
    // bail out and return nil so the table shows "—".
    let dpr: Double?
    if let srcDpr = source.dollarPerPr, let tgtDpr = target.dollarPerPr {
        var num = 0.0, den = 0.0
        for row in eligible {
            if row.model == source.model {
                if srcComplete > 0 {
                    num += srcDpr * Double(srcComplete)
                    den += Double(srcComplete)
                }
            } else if row.model == target.model {
                if tgtComplete > 0 {
                    num += tgtDpr * Double(tgtComplete)
                    den += Double(tgtComplete)
                }
            } else if let c = row.totalCostUsd, row.completeCount > 0 {
                num += c
                den += Double(row.completeCount)
            }
        }
        dpr = den > 0 ? num / den : nil
    } else {
        dpr = nil
    }

    // Avg quality — weight by scoredCount.
    // Null target.avgQuality: the redirected target slice contributes nothing.
    // This is the honest behavior when target has no quality signal — we don't
    // silently impute a value; we just lose that slice from the denominator too.
    var qNum = 0.0, qDen = 0.0
    for row in eligible {
        let (count, quality): (Int, Double?)
        if row.model == source.model {
            (count, quality) = (srcScored, row.avgQuality)
        } else if row.model == target.model {
            (count, quality) = (tgtScored, row.avgQuality)
        } else {
            (count, quality) = (row.scoredCount, row.avgQuality)
        }
        if let q = quality, count > 0 {
            qNum += q * Double(count)
            qDen += Double(count)
        }
    }
    let avgQuality: Double? = qDen > 0 ? qNum / qDen : nil

    // Success rate — weight by podCount; historical per-pod rate is unchanged.
    var sNum = 0.0, sDen = 0.0
    for row in eligible {
        let pods = row.model == source.model ? srcPods : (row.model == target.model ? tgtPods : row.podCount)
        if pods > 0 { sNum += row.successRate * Double(pods); sDen += Double(pods) }
    }
    let successRate = sDen > 0 ? sNum / sDen : 0

    // Mean TTM — weight by completeCount.
    // Null target.meanTtmSeconds: redirected target slice contributes nothing (same
    // rationale as quality: honest null propagation when target has no complete pods).
    var tNum = 0.0, tDen = 0.0
    for row in eligible {
        let (count, ttm): (Int, Double?)
        if row.model == source.model {
            (count, ttm) = (srcComplete, row.meanTtmSeconds)
        } else if row.model == target.model {
            (count, ttm) = (tgtComplete, row.meanTtmSeconds)
        } else {
            (count, ttm) = (row.completeCount, row.meanTtmSeconds)
        }
        if let t = ttm, count > 0 { tNum += t * Double(count); tDen += Double(count) }
    }
    let meanTtmSeconds: Double? = tDen > 0 ? tNum / tDen : nil

    // Escalation rate — weight by podCount; historical per-pod rate is unchanged.
    var eNum = 0.0, eDen = 0.0
    for row in eligible {
        let pods = row.model == source.model ? srcPods : (row.model == target.model ? tgtPods : row.podCount)
        if pods > 0 { eNum += row.escalationRate * Double(pods); eDen += Double(pods) }
    }
    let escalationRate = eDen > 0 ? eNum / eDen : 0

    return SimulatedFleet(
        dollarPerPr: dpr,
        avgQuality: avgQuality,
        successRate: successRate,
        meanTtmSeconds: meanTtmSeconds,
        escalationRate: escalationRate
    )
}

// MARK: - Baseline (zero-redirect short-circuit)

/// Cohort-weighted fleet averages over `eligible` with no redirect applied.
/// Used directly for the 0% short-circuit so there is no floating-point recompute
/// of totalCostUsd from dollarPerPr (which would introduce precision drift at 0%).
private func fleetBaseline(_ eligible: [PerModelAggregate]) -> SimulatedFleet {
    var cNum = 0.0, cDen = 0.0
    for row in eligible {
        if let c = row.totalCostUsd, row.completeCount > 0 {
            cNum += c; cDen += Double(row.completeCount)
        }
    }

    var qNum = 0.0, qDen = 0.0
    for row in eligible {
        if let q = row.avgQuality, row.scoredCount > 0 {
            qNum += q * Double(row.scoredCount); qDen += Double(row.scoredCount)
        }
    }

    var sNum = 0.0, sDen = 0.0
    for row in eligible { sNum += row.successRate * Double(row.podCount); sDen += Double(row.podCount) }

    var tNum = 0.0, tDen = 0.0
    for row in eligible {
        if let t = row.meanTtmSeconds, row.completeCount > 0 {
            tNum += t * Double(row.completeCount); tDen += Double(row.completeCount)
        }
    }

    var eNum = 0.0, eDen = 0.0
    for row in eligible { eNum += row.escalationRate * Double(row.podCount); eDen += Double(row.podCount) }

    return SimulatedFleet(
        dollarPerPr: cDen > 0 ? cNum / cDen : nil,
        avgQuality: qDen > 0 ? qNum / qDen : nil,
        successRate: sDen > 0 ? sNum / sDen : 0,
        meanTtmSeconds: tDen > 0 ? tNum / tDen : nil,
        escalationRate: eDen > 0 ? eNum / eDen : 0
    )
}

private extension SimulatedFleet {
    static let empty = SimulatedFleet(
        dollarPerPr: nil, avgQuality: nil, successRate: 0, meanTtmSeconds: nil, escalationRate: 0
    )
}
