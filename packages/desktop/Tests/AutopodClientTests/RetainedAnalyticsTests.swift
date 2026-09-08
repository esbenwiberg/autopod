import Foundation
import Testing
@testable import AutopodClient

@Test(arguments: [false, true])
func retainedAnalyticsPreservesArchivedIdentityAndLegacyAbsence(archived: Bool) throws {
    let marker = archived ? ",\"historyArchived\":true" : ""
    let throughput = Data("{\"podId\":\"retained\",\"profile\":\"profile\",\"status\":\"failed\",\"completedAt\":\"2026-09-08T00:00:00Z\"\(marker)}".utf8)
    let pod = try JSONDecoder().decode(ThroughputCohortPod.self, from: throughput)
    #expect(pod.historyArchived == (archived ? true : nil))
    let reliability = Data("{\"podId\":\"retained\",\"profile\":\"profile\",\"finalStatus\":\"failed\",\"completedAt\":\"2026-09-08T00:00:00Z\"\(marker)}".utf8)
    let drop = try JSONDecoder().decode(DropPodEntry.self, from: reliability)
    #expect(drop.historyArchived == (archived ? true : nil))
}
