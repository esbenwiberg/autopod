import AutopodClient
import Foundation

/// Shared with the standalone retry card. Stable keys retain uncertain decisions.
internal enum RetryAuthorizationDraft {
  static func key(scope: String, podId: String, stage: String) -> String {
    "autopod.retry-authorization.\(scope).\(podId)" + (stage == "validation" ? "" : ".\(stage)")
  }
  static func load(_ key: String) throws -> TaskRetryAuthorizationRequest? {
    guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
    return try JSONDecoder().decode(TaskRetryAuthorizationRequest.self, from: data)
  }
  static func save(_ draft: TaskRetryAuthorizationRequest, key: String) throws {
    UserDefaults.standard.set(try JSONEncoder().encode(draft), forKey: key)
  }
  static func clear(_ key: String) { UserDefaults.standard.removeObject(forKey: key) }
}
