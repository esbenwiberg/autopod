import AuthenticationServices
import AppKit
import CryptoKit
import Foundation
import Security
import AutopodClient

public struct EntraDesktopAuthConfiguration: Sendable {
  public let tenantId: String
  public let clientId: String
  public let scope: String
  public let redirectURI: String
  public let callbackScheme: String

  public init(
    tenantId: String = "0d3aa8f9-8168-4bc2-bda1-c3972e6d9352",
    clientId: String = "3ccd604d-3887-4309-9988-739358fb5811",
    scope: String? = nil,
    redirectURI: String = "msauth.com.autopod.desktop://auth",
    callbackScheme: String = "msauth.com.autopod.desktop"
  ) {
    self.tenantId = tenantId
    self.clientId = clientId
    self.scope = scope ?? "openid profile offline_access api://\(clientId)/access_as_user"
    self.redirectURI = redirectURI
    self.callbackScheme = callbackScheme
  }

  var authorityBaseURL: URL {
    URL(string: "https://login.microsoftonline.com/\(tenantId)/oauth2/v2.0")!
  }

  var cacheAccount: String {
    "entra-token.\(tenantId).\(clientId)"
  }
}

public enum EntraDesktopAuthError: Error, LocalizedError, Sendable {
  case missingCallbackURL
  case stateMismatch
  case signInCancelled
  case tokenNotCached
  case refreshTokenMissing
  case http(Int, String)
  case entra(String)
  case invalidResponse(String)

  public var errorDescription: String? {
    switch self {
    case .missingCallbackURL:
      return "Microsoft sign-in did not return a callback URL."
    case .stateMismatch:
      return "Microsoft sign-in returned an unexpected state. Try signing in again."
    case .signInCancelled:
      return "Microsoft sign-in was cancelled."
    case .tokenNotCached:
      return "No Microsoft sign-in is cached. Sign in with Microsoft again."
    case .refreshTokenMissing:
      return "The cached Microsoft session cannot refresh. Sign in with Microsoft again."
    case .http(let status, let message):
      return "Microsoft token request failed (\(status)): \(Self.friendly(message))"
    case .entra(let message):
      return Self.friendly(message)
    case .invalidResponse(let message):
      return "Microsoft sign-in returned an invalid response: \(message)"
    }
  }

  private static func friendly(_ message: String) -> String {
    if message.contains("AADSTS50011") {
      return "Missing desktop redirect URI. Add msauth.com.autopod.desktop://auth as a Mobile and desktop redirect URI in the Entra app registration."
    }
    if message.contains("AADSTS50020") || message.contains("AADSTS50034") {
      return "Wrong tenant or account. Sign in with a user from the configured Autopod tenant."
    }
    if message.contains("AADSTS65001") || message.contains("consent") {
      return "Consent is missing or revoked for the Autopod daemon API. Grant consent, then sign in again."
    }
    if message.contains("invalid_scope") || message.contains("access_as_user") {
      return "Wrong daemon API audience or scope. The desktop app needs api://3ccd604d-3887-4309-9988-739358fb5811/access_as_user."
    }
    if message.contains("invalid_grant") {
      return "The Microsoft session expired or was revoked. Sign in with Microsoft again."
    }
    return message
  }
}

public actor EntraDesktopAuthService {
  private let configuration: EntraDesktopAuthConfiguration
  private let session: URLSession
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(
    configuration: EntraDesktopAuthConfiguration = EntraDesktopAuthConfiguration(),
    session: URLSession = .shared
  ) {
    self.configuration = configuration
    self.session = session
    encoder.dateEncodingStrategy = .iso8601
    decoder.dateDecodingStrategy = .iso8601
  }

  public func signIn() async throws -> String {
    let verifier = Self.randomURLSafeString(byteCount: 48)
    let challenge = Self.codeChallenge(for: verifier)
    let state = Self.randomURLSafeString(byteCount: 32)

    var components = URLComponents(
      url: configuration.authorityBaseURL.appendingPathComponent("authorize"),
      resolvingAgainstBaseURL: false
    )!
    components.queryItems = [
      URLQueryItem(name: "client_id", value: configuration.clientId),
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "redirect_uri", value: configuration.redirectURI),
      URLQueryItem(name: "response_mode", value: "query"),
      URLQueryItem(name: "scope", value: configuration.scope),
      URLQueryItem(name: "code_challenge", value: challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "prompt", value: "select_account"),
    ]

    guard let authURL = components.url else {
      throw EntraDesktopAuthError.invalidResponse("could not build authorization URL")
    }

    let callbackURL = try await runAuthenticationSession(url: authURL)
    let callbackComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
    let queryItems = callbackComponents?.queryItems ?? []
    if let error = queryItems.first(named: "error")?.value {
      let description = queryItems.first(named: "error_description")?.value ?? error
      throw EntraDesktopAuthError.entra(description)
    }
    guard queryItems.first(named: "state")?.value == state else {
      throw EntraDesktopAuthError.stateMismatch
    }
    guard let code = queryItems.first(named: "code")?.value else {
      throw EntraDesktopAuthError.invalidResponse("authorization code missing")
    }

    let token = try await exchangeCode(code, verifier: verifier)
    try save(token)
    return token.accessToken
  }

  public func accessToken() async throws -> String {
    let cached = try loadCachedToken()
    if cached.isValid() {
      return cached.accessToken
    }
    let refreshed = try await refresh(cached)
    try save(refreshed)
    return refreshed.accessToken
  }

  public func cachedAccessTokenIfValid() throws -> String? {
    guard let token = try? loadCachedToken(), token.isValid() else { return nil }
    return token.accessToken
  }

  public func signOut() {
    KeychainHelper.delete(account: configuration.cacheAccount)
  }

  private func runAuthenticationSession(url: URL) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      Task { @MainActor in
        AuthenticationPresentationContextProvider.shared.start(
          url: url,
          callbackURLScheme: configuration.callbackScheme
        ) { result in
          switch result {
          case .success(let callbackURL):
            continuation.resume(returning: callbackURL)
          case .failure(let error):
            continuation.resume(throwing: error)
          }
        }
      }
    }
  }

  private func exchangeCode(_ code: String, verifier: String) async throws -> EntraCachedToken {
    try await tokenRequest([
      "client_id": configuration.clientId,
      "scope": configuration.scope,
      "code": code,
      "redirect_uri": configuration.redirectURI,
      "grant_type": "authorization_code",
      "code_verifier": verifier,
    ])
  }

  private func refresh(_ cached: EntraCachedToken) async throws -> EntraCachedToken {
    guard let refreshToken = cached.refreshToken, !refreshToken.isEmpty else {
      throw EntraDesktopAuthError.refreshTokenMissing
    }
    return try await tokenRequest([
      "client_id": configuration.clientId,
      "scope": configuration.scope,
      "refresh_token": refreshToken,
      "grant_type": "refresh_token",
    ])
  }

  private func tokenRequest(_ parameters: [String: String]) async throws -> EntraCachedToken {
    let endpoint = configuration.authorityBaseURL.appendingPathComponent("token")
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Self.formEncode(parameters).data(using: .utf8)

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw EntraDesktopAuthError.invalidResponse(error.localizedDescription)
    }

    guard let http = response as? HTTPURLResponse else {
      throw EntraDesktopAuthError.invalidResponse("non-HTTP token response")
    }

    if !(200..<300).contains(http.statusCode) {
      let message = Self.decodeTokenError(data) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
      throw EntraDesktopAuthError.http(http.statusCode, message)
    }

    do {
      let token = try decoder.decode(TokenEndpointResponse.self, from: data)
      return EntraCachedToken(
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: Date().addingTimeInterval(TimeInterval(token.expiresIn)),
        scope: token.scope
      )
    } catch {
      throw EntraDesktopAuthError.invalidResponse(error.localizedDescription)
    }
  }

  private func loadCachedToken() throws -> EntraCachedToken {
    guard let raw = KeychainHelper.loadString(account: configuration.cacheAccount),
          let data = raw.data(using: .utf8) else {
      throw EntraDesktopAuthError.tokenNotCached
    }
    return try decoder.decode(EntraCachedToken.self, from: data)
  }

  private func save(_ token: EntraCachedToken) throws {
    let data = try encoder.encode(token)
    guard let raw = String(data: data, encoding: .utf8) else {
      throw EntraDesktopAuthError.invalidResponse("could not encode token cache")
    }
    try KeychainHelper.saveString(raw, account: configuration.cacheAccount)
  }

  private static func formEncode(_ parameters: [String: String]) -> String {
    parameters
      .map { key, value in "\(percentEncode(key))=\(percentEncode(value))" }
      .sorted()
      .joined(separator: "&")
  }

  private static func percentEncode(_ value: String) -> String {
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&+=?")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
  }

  private static func decodeTokenError(_ data: Data) -> String? {
    guard let body = try? JSONDecoder().decode(TokenErrorResponse.self, from: data) else {
      return String(data: data, encoding: .utf8)
    }
    return [body.error, body.errorDescription].compactMap { $0 }.joined(separator: ": ")
  }

  private static func randomURLSafeString(byteCount: Int) -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    return Data(bytes).base64URLEncodedString()
  }

  private static func codeChallenge(for verifier: String) -> String {
    let digest = SHA256.hash(data: Data(verifier.utf8))
    return Data(digest).base64URLEncodedString()
  }
}

private final class AuthenticationPresentationContextProvider: NSObject,
  ASWebAuthenticationPresentationContextProviding {
  static let shared = AuthenticationPresentationContextProvider()

  private var activeSession: ASWebAuthenticationSession?

  func start(
    url: URL,
    callbackURLScheme: String,
    completion: @escaping (Result<URL, Error>) -> Void
  ) {
    let session = ASWebAuthenticationSession(
      url: url,
      callbackURLScheme: callbackURLScheme
    ) { [weak self] callbackURL, error in
      self?.activeSession = nil
      if let callbackURL {
        completion(.success(callbackURL))
        return
      }
      if let authError = error as? ASWebAuthenticationSessionError,
         authError.code == .canceledLogin {
        completion(.failure(EntraDesktopAuthError.signInCancelled))
        return
      }
      if let error {
        completion(.failure(error))
        return
      }
      completion(.failure(EntraDesktopAuthError.missingCallbackURL))
    }
    session.presentationContextProvider = self
    session.prefersEphemeralWebBrowserSession = false
    activeSession = session
    session.start()
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    NSApplication.shared.keyWindow ?? ASPresentationAnchor()
  }
}

private struct TokenEndpointResponse: Decodable {
  let accessToken: String
  let refreshToken: String?
  let expiresIn: Int
  let scope: String?

  private enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
    case expiresIn = "expires_in"
    case scope
  }
}

private struct TokenErrorResponse: Decodable {
  let error: String?
  let errorDescription: String?

  private enum CodingKeys: String, CodingKey {
    case error
    case errorDescription = "error_description"
  }
}

private extension Data {
  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

private extension Array where Element == URLQueryItem {
  func first(named name: String) -> URLQueryItem? {
    first { $0.name == name }
  }
}
