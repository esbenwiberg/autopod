import AutopodClient
import Foundation

/// Production uses DaemonAPI; the isolated design Preview uses an in-memory fixture actor.
protocol ScanInboxAPI: Sendable {
  var baseURL: URL { get }
  func listScanReportPage(_ jobID: String, before: String?) async throws -> ScanReportPage
  func getScanReportReview(_ id: String) async throws -> ScanReportDetail
  func getScanFindings(_ id: String, after: String?) async throws -> ScanFindingPage
  func getScanDecisions(_ id: String, before: String?) async throws -> ScanDecisionPage
  func updateScheduledJob(_ id: String, _ body: UpdateScheduledJobRequest) async throws -> ScheduledJob
  func triageScanReport(_ id: String, _ body: ScanTriageRequest) async throws -> ScanTriageDecision
  func launchScanRepair(_ reportID: String, selectionId: String) async throws -> ScanRepairDispatch
}
extension DaemonAPI: ScanInboxAPI {}
