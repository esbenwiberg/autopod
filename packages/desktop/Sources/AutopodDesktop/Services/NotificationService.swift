import Foundation
import UserNotifications
import AutopodUI

/// Sends native macOS notifications for session events.
@MainActor
final class NotificationService: NSObject, UNUserNotificationCenterDelegate, Sendable {
  static let shared = NotificationService()

  private override init() {
    super.init()
  }

  func requestPermission() async {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
  }

  func notifyEscalation(session: Session, question: String) {
    let content = UNMutableNotificationContent()
    content.title = "Agent needs input"
    content.subtitle = session.branch
    content.body = question
    content.sound = .default
    content.categoryIdentifier = "ESCALATION"
    post(id: "escalation-\(session.id)", content: content)
  }

  func notifyValidationComplete(session: Session, passed: Bool) {
    let content = UNMutableNotificationContent()
    content.title = passed ? "Validation passed" : "Validation failed"
    content.subtitle = session.branch
    content.body = passed ? "Ready for review" : "Check the validation results"
    content.sound = .default
    content.categoryIdentifier = passed ? "VALIDATION_PASS" : "VALIDATION_FAIL"
    post(id: "validation-\(session.id)", content: content)
  }

  func notifySessionFailed(session: Session, error: String) {
    let content = UNMutableNotificationContent()
    content.title = "Session failed"
    content.subtitle = session.branch
    content.body = error
    content.sound = .default
    post(id: "failed-\(session.id)", content: content)
  }

  func notifySessionComplete(session: Session) {
    let content = UNMutableNotificationContent()
    content.title = "Session complete"
    content.subtitle = session.branch
    content.body = session.prUrl.map { "PR: \($0.absoluteString)" } ?? "Done"
    content.sound = .default
    post(id: "complete-\(session.id)", content: content)
  }

  func registerCategories() {
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

    UNUserNotificationCenter.current().setNotificationCategories([validationCategory, escalationCategory])
  }

  // MARK: - Delegate

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }

  // MARK: - Private

  private func post(id: String, content: UNMutableNotificationContent) {
    let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }
}
