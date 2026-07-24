import Foundation
import XCTest
@testable import AutopodClient
@testable import AutopodUI

final class ProviderCatalogTests: XCTestCase {
  private func catalog() throws -> ProviderCatalogResponse {
    let json = """
    {
      "manifestVersion": 1,
      "piCompatibility": {
        "packageName": "@earendil-works/pi-coding-agent",
        "packageVersion": "0.80.6",
        "source": "pinned-distribution"
      },
      "providers": [
        {
          "id": "fixture-cloud",
          "displayName": "Fixture Cloud",
          "description": "Synthetic provider",
          "icon": "unknown-icon-token",
          "implementation": { "kind": "generic-pi-api", "piProviderId": "fixture" },
          "credentialOptions": [
            { "kind": "api-key", "label": "Fixture key", "acquisition": "Create a fixture key." }
          ],
          "modelIds": ["fixture/model-a"],
          "requiredHosts": ["api.fixture.invalid"],
          "policy": {
            "lifecycle": "active",
            "authorization": "supported",
            "runnable": true,
            "caveats": [
              { "kind": "privacy", "severity": "warning", "message": "Review privacy." }
            ]
          }
        },
        {
          "id": "blocked-fixture",
          "displayName": "Blocked Fixture",
          "description": "Blocked pending authorization",
          "implementation": { "kind": "generic-pi-api", "piProviderId": "blocked" },
          "credentialOptions": [
            { "kind": "api-key", "label": "Blocked key", "acquisition": "Do not create." }
          ],
          "modelIds": [],
          "requiredHosts": [],
          "policy": {
            "lifecycle": "experimental",
            "authorization": "blocked",
            "runnable": false,
            "caveats": [
              {
                "kind": "subscription",
                "severity": "blocking",
                "message": "Pending explicit authorization."
              }
            ]
          }
        }
      ],
      "models": [
        {
          "id": "fixture/model-a",
          "providerId": "fixture-cloud",
          "displayName": "Fixture Model A",
          "lifecycle": "active"
        }
      ]
    }
    """
    return try JSONDecoder().decode(ProviderCatalogResponse.self, from: Data(json.utf8))
  }

  func testSyntheticProviderAppearsWithSafePresentationAndPolicy() throws {
    let catalog = try catalog()
    let provider = try XCTUnwrap(catalog.provider(id: "fixture-cloud"))
    XCTAssertEqual(provider.displayName, "Fixture Cloud")
    XCTAssertEqual(provider.systemImage, "person.badge.key")
    XCTAssertTrue(provider.canAcceptGenericAPIKey)
    XCTAssertEqual(provider.policy.caveats.first?.kind, "privacy")

    let blocked = try XCTUnwrap(catalog.provider(id: "blocked-fixture"))
    XCTAssertFalse(blocked.canAcceptGenericAPIKey)
    XCTAssertFalse(blocked.isSelectableAsProfileProvider)
    XCTAssertEqual(blocked.policy.authorization, "blocked")
    XCTAssertTrue(RuntimeModelOptions.options(
      for: .pi,
      role: .defaultModel,
      catalog: catalog,
      providerId: blocked.id
    ).isEmpty)
  }

  func testSyntheticProviderModelAppearsWithoutSourceEnumeration() throws {
    let catalog = try catalog()
    let options = RuntimeModelOptions.options(
      for: .pi,
      role: .defaultModel,
      catalog: catalog,
      providerId: "fixture-cloud"
    )
    XCTAssertTrue(options.contains {
      $0.value == "fixture/model-a" && $0.label == "Fixture Model A"
    })
  }

  func testCatalogFailurePreservesCurrentSelection() {
    let current = "temporarily-unavailable/model"
    let options = RuntimeModelOptions.options(
      for: .pi,
      role: .defaultModel,
      currentValue: current,
      catalog: nil,
      providerId: "temporarily-unavailable"
    )
    XCTAssertEqual(options.last?.value, current)
  }
}
