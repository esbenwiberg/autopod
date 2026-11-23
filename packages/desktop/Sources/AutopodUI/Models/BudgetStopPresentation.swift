import Foundation

extension Pod {
  /// Presentation hint only; the daemon independently requires exact stop,
  /// preservation, task-budget and retry evidence before coding can continue.
  var isBudgetStopped: Bool {
    [.failed, .reviewRequired].contains(status)
      && errorSummary?.hasPrefix("Token budget exceeded (") == true
  }

  /// Paused on a soft token limit and awaiting human approval (`ap budget --continue`).
  /// Presentation hint only; the daemon rejects approval when the pod is not budget-paused.
  var isBudgetPaused: Bool { status == .paused && pauseReason == "budget" }
}
