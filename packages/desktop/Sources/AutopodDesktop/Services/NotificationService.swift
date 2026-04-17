import Foundation
import UserNotifications
import AutopodUI

/// Sends native macOS notifications for pod events.
@MainActor
public final class NotificationService: NSObject, UNUserNotificationCenterDelegate, Sendable {
  public static let shared = NotificationService()

  /// Injected by AppRootView to handle Run Now / Skip notification actions.
  public weak var scheduledJobStore: ScheduledJobStore?

  /// Whether notifications are available (requires app bundle with bundle ID)
  private var isAvailable: Bool {
    Bundle.main.bundleIdentifier != nil
  }

  private override init() {
    super.init()
  }

  public func requestPermission() async {
    guard isAvailable else { return }
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
  }

  public func notifyEscalation(pod: Pod, question: String) {
    let content = UNMutableNotificationContent()
    content.title = "Agent needs input"
    content.subtitle = pod.branch
    content.body = question
    content.sound = .default
    content.categoryIdentifier = "ESCALATION"
    post(id: "escalation-\(pod.id)", content: content)
  }

  public func notifyValidationComplete(pod: Pod, passed: Bool) {
    let content = UNMutableNotificationContent()
    content.title = passed ? "Validation passed" : "Validation failed"
    content.subtitle = pod.branch
    content.body = passed ? "Ready for review" : "Check the validation results"
    content.sound = .default
    content.categoryIdentifier = passed ? "VALIDATION_PASS" : "VALIDATION_FAIL"
    post(id: "validation-\(pod.id)", content: content)
  }

  public func notifySessionFailed(pod: Pod, error: String) {
    let content = UNMutableNotificationContent()
    content.title = "Pod failed"
    content.subtitle = pod.branch
    content.body = error
    content.sound = .default
    post(id: "failed-\(pod.id)", content: content)
  }

  public func notifySessionComplete(pod: Pod) {
    let content = UNMutableNotificationContent()
    content.title = "Pod complete"
    content.subtitle = pod.branch
    content.body = pod.prUrl.map { "PR: \($0.absoluteString)" } ?? "Done"
    content.sound = .default
    post(id: "complete-\(pod.id)", content: content)
  }

  public func notifyMissedJob(jobId: String, jobName: String, lastRunAt: String?) {
    let content = UNMutableNotificationContent()
    content.title = "Scheduled Job Missed"
    if lastRunAt != nil {
      content.body = "\"\(jobName)\" was due to run but was missed. Run now?"
    } else {
      content.body = "\"\(jobName)\" has never run. Run now?"
    }
    content.sound = .default
    content.categoryIdentifier = "MISSED_JOB"
    content.userInfo = ["jobId": jobId]
    post(id: "missed-job-\(jobId)", content: content)
  }

  public func registerCategories() {
    guard isAvailable else { return }
    let approve = UNNotificationAction(identifier: "APPROVE", title: "Approve", options: [])
    let view = UNNotificationAction(identifier: "VIEW", title: "View", options: [.foreground])

    let validationCategory = UNNotificationCategory(
      identifier: "VALIDATION_PASS",
      actions: [approve, view],
      intentIdentifiers: []
    )
    let escalationCategory = UNNotificationCategory(
      identifier: "ESCALATION",
      actions: [view],
      intentIdentifiers: []
    )

    let runNow = UNNotificationAction(identifier: "RUN_NOW", title: "Run Now", options: [.foreground])
    let skip = UNNotificationAction(identifier: "SKIP", title: "Skip", options: [])
    let missedJobCategory = UNNotificationCategory(
      identifier: "MISSED_JOB",
      actions: [runNow, skip],
      intentIdentifiers: []
    )

    UNUserNotificationCenter.current().setNotificationCategories([
      validationCategory, escalationCategory, missedJobCategory,
    ])
  }

  // MARK: - Delegate

  nonisolated public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }

  nonisolated public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    let userInfo = response.notification.request.content.userInfo
    guard let jobId = userInfo["jobId"] as? String else { return }
    let actionId = response.actionIdentifier
    await MainActor.run {
      switch actionId {
      case "RUN_NOW":
        if let store = NotificationService.shared.scheduledJobStore {
          Task { try? await store.runCatchup(jobId) }
        }
      case "SKIP":
        if let store = NotificationService.shared.scheduledJobStore {
          Task { try? await store.skipCatchup(jobId) }
        }
      default:
        break
      }
    }
  }

  // MARK: - Private

  private func post(id: String, content: UNMutableNotificationContent) {
    guard isAvailable else { return }
    let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }
}
