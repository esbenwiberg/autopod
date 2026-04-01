import Foundation
import Security

/// Stores and retrieves daemon tokens in the macOS Keychain.
public enum KeychainHelper {

  private static let service = "com.autopod.desktop"

  public static func save(token: String, for connectionId: UUID) throws {
    let account = connectionId.uuidString
    let data = Data(token.utf8)

    // Delete any existing item first
    let deleteQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(deleteQuery as CFDictionary)

    // Add new item
    let addQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]

    let status = SecItemAdd(addQuery as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.saveFailed(status)
    }
  }

  public static func load(for connectionId: UUID) -> String? {
    let account = connectionId.uuidString

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)

    guard status == errSecSuccess, let data = result as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  public static func delete(for connectionId: UUID) {
    let account = connectionId.uuidString

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]

    SecItemDelete(query as CFDictionary)
  }

  public enum KeychainError: Error, LocalizedError {
    case saveFailed(OSStatus)

    public var errorDescription: String? {
      switch self {
      case .saveFailed(let status):
        "Keychain save failed (status: \(status))"
      }
    }
  }
}
