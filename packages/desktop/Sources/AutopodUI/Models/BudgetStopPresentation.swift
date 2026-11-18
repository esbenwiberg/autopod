import Foundation

extension Pod {
  /// Presentation hint only; the daemon independently requires exact stop,
  /// preservation, task-budget and retry evidence before coding can continue.
  var isBudgetStopped: Bool {
    [.failed, .reviewRequired].contains(status)
      && errorSummary?.hasPrefix("Token budget exceeded (") == true
  }
}
