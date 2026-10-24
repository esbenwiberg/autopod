import Foundation
import Testing
@testable import AutopodUI

struct DesktopTimingCase: Codable {
    let scope: String
    let action: String
    var samplesMs: [Double] = []
    var failures: [String] = []
    var failedAttemptDurationsMs: [Double] = []
    var timeouts = 0
    var warmupsCompleted = 0
    var abortedReason: String?
    var p50Ms: Double? { percentile(0.5) }
    var p95Ms: Double? { percentile(0.95) }
    private func percentile(_ fraction: Double) -> Double? {
        guard !samplesMs.isEmpty, abortedReason == nil else { return nil }
        return samplesMs.sorted()[Int(ceil(Double(samplesMs.count) * fraction)) - 1]
    }
}

@Suite(.serialized) @MainActor struct DesktopSelectionPerformanceTests {
    @Test func mountedFleetSelectionLatency() async throws {
        let env = ProcessInfo.processInfo.environment
        let mode = env["AUTOPOD_DESKTOP_PERF_MODE"] ?? "functional"
        let warmups = mode == "functional" ? 0 : 20
        let iterations = mode == "functional" ? 1 : 100
        var results: [DesktopTimingCase] = []
        for scope in ["active", "recent", "repository"] {
            let host = try DesktopSelectionPerformanceHost()
            defer { host.close() }
            try await host.scope(scope)
            let targets = scope == "repository" ? ["perf-0000", "perf-0010"] : ["perf-0000", "perf-0001"]
            for action in ["pod", "overview", "work", "validation", "readiness", "evidence", "diff", "logs"] {
                var result = DesktopTimingCase(scope: scope, action: action)
                for iteration in 0..<(warmups + iterations) {
                    let attemptStart = ContinuousClock.now
                    do {
                        let target = targets[(iteration + 1) % 2]
                        if action == "pod" {
                            try await host.selectTab("overview")
                        } else {
                            try await host.selectTab(action == "overview" ? "work" : "overview")
                        }
                        let milliseconds = try await host.transition(tab: action == "pod" ? nil : action,
                            podID: action == "pod" ? target : try #require(host.inputs.selectedID))
                        if iteration < warmups { result.warmupsCompleted += 1 }
                        else { result.samplesMs.append(milliseconds) }
                    } catch {
                        result.timeouts += 1
                        let elapsed = attemptStart.duration(to: .now).components
                        result.failedAttemptDurationsMs.append(Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15)
                        result.failures.append("Attempt \(iteration), including reset: \(error)")
                        if mode == "functional" { throw error }
                        if result.timeouts >= 3 {
                            result.abortedReason = "Three transition/setup failures: \(error)"
                            break
                        }
                    }
                }
                results.append(result)
                print("Desktop timing \(scope)/\(action): n=\(result.samplesMs.count), p95=\(result.p95Ms.map(String.init(describing:)) ?? "unavailable"), failures=\(result.timeouts)")
            }
        }
        if let path = env["AUTOPOD_DESKTOP_PERF_REPORT"] {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(results).write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        if mode == "verify" {
            for result in results {
                #expect(result.timeouts == 0 && result.samplesMs.count == 100)
                #expect(try #require(result.p95Ms) <= 250,
                    "\(result.scope)/\(result.action) exceeds the agreed native cached-content target")
            }
        }
    }
}
