import Foundation
import AutopodClient

/// Manages scheduled job state — loading from REST, updating from events.
@Observable
@MainActor
public final class ScheduledJobStore {

  // MARK: - Published state

  public private(set) var jobs: [ScheduledJob] = []
  public private(set) var isLoading = false
  public var error: String?

  private var api: DaemonAPI?

  public init() {}

  // MARK: - Computed

  public var pendingCatchupJobs: [ScheduledJob] {
    jobs.filter { $0.catchupPending }
  }

  // MARK: - Configuration

  public func configure(api: DaemonAPI) {
    self.api = api
  }

  // MARK: - Load

  public func load() async {
    guard let api else { return }
    isLoading = true
    error = nil
    do {
      jobs = try await api.listScheduledJobs()
    } catch {
      self.error = error.localizedDescription
    }
    isLoading = false
  }

  // MARK: - Refresh single job

  public func refreshJob(_ id: String) async {
    guard let api else { return }
    do {
      let updated = try await api.getScheduledJob(id)
      if let idx = jobs.firstIndex(where: { $0.id == id }) {
        jobs[idx] = updated
      } else {
        jobs.append(updated)
      }
    } catch {
      // Job may have been deleted — leave list unchanged
    }
  }

  // MARK: - Optimistic updates

  /// Called when a catchup_requested event arrives — refresh so catchupPending shows immediately.
  public func markCatchupPending(_ jobId: String) {
    Task { await refreshJob(jobId) }
  }

  // MARK: - Actions

  public func runCatchup(_ jobId: String) async throws {
    guard let api else { return }
    _ = try await api.runScheduledJobCatchup(jobId)
    await refreshJob(jobId)
  }

  public func skipCatchup(_ jobId: String) async throws {
    guard let api else { return }
    try await api.skipScheduledJobCatchup(jobId)
    await refreshJob(jobId)
  }

  public func triggerJob(_ jobId: String) async throws {
    guard let api else { return }
    _ = try await api.triggerScheduledJob(jobId)
    await refreshJob(jobId)
  }

  public func createJob(_ request: CreateScheduledJobRequest) async throws {
    guard let api else { return }
    let job = try await api.createScheduledJob(request)
    jobs.append(job)
  }

  public func updateJob(_ jobId: String, _ request: UpdateScheduledJobRequest) async throws {
    guard let api else { return }
    let updated = try await api.updateScheduledJob(jobId, request)
    if let idx = jobs.firstIndex(where: { $0.id == jobId }) {
      jobs[idx] = updated
    }
  }

  public func deleteJob(_ jobId: String) async throws {
    guard let api else { return }
    try await api.deleteScheduledJob(jobId)
    jobs.removeAll { $0.id == jobId }
  }
}
