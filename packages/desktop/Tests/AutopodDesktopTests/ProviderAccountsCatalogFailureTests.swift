import Foundation
import XCTest
@testable import AutopodClient
@testable import AutopodDesktop

final class ProviderAccountsCatalogFailureTests: XCTestCase {
  func testCatalogRefreshFailureClearsPolicyButPreservesAccounts() throws {
    let account = try JSONDecoder().decode(
      PublicProviderAccountResponse.self,
      from: Data(
        """
        {
          "id": "fixture-account",
          "name": "Fixture",
          "provider": "fixture-cloud",
          "hasCredentials": true,
          "createdAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-01T00:00:00.000Z"
        }
        """.utf8
      )
    )
    let failure = ProviderAccountsCatalogFailure(
      preserving: [account],
      error: NSError(
        domain: "ProviderAccountsCatalogFailureTests",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "daemon unavailable"]
      )
    )

    XCTAssertEqual(failure.accounts.map(\.id), ["fixture-account"])
    XCTAssertNil(failure.catalog)
    XCTAssertTrue(failure.errorMessage.contains("Provider catalog unavailable"))
    XCTAssertTrue(failure.errorMessage.contains("refresh to manage credentials"))
  }
}
