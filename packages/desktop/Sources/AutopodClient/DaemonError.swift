import Foundation

public enum DaemonError: Error, LocalizedError, Sendable {
  case unauthorized(String?)
  case notFound(String)
  case badRequest(String)
  case serverError(Int, String)
  case networkError(String)
  case decodingError(String)

  public var errorDescription: String? {
    switch self {
    case .unauthorized(let message):
      if let message, !message.isEmpty {
        "Unauthorized — \(message)"
      } else {
        "Unauthorized — check your token"
      }
    case .notFound(let path):
      "Not found: \(path)"
    case .badRequest(let message):
      "Bad request: \(message)"
    case .serverError(let code, let message):
      "Server error (\(code)): \(message)"
    case .networkError(let message):
      "Network error: \(message)"
    case .decodingError(let message):
      "Decoding error: \(message)"
    }
  }
}
