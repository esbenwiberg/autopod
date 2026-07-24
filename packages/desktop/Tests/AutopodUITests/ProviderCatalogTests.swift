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
        },
        {
          "id": "synthetic-legacy-product",
          "displayName": "Synthetic Anthropic Adapter",
          "description": "Synthetic supported legacy adapter",
          "implementation": { "kind": "legacy", "adapterId": "anthropic" },
          "credentialOptions": [],
          "modelIds": [],
          "requiredHosts": [],
          "policy": {
            "lifecycle": "active",
            "authorization": "supported",
            "runnable": true,
            "caveats": []
          }
        },
        {
          "id": "unsupported-legacy-product",
          "displayName": "Unsupported Legacy Adapter",
          "description": "Synthetic unsupported legacy adapter",
          "implementation": { "kind": "legacy", "adapterId": "future-adapter" },
          "credentialOptions": [],
          "modelIds": [],
          "requiredHosts": [],
          "policy": {
            "lifecycle": "active",
            "authorization": "supported",
            "runnable": true,
            "caveats": []
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
    XCTAssertTrue(provider.isCompatible(profileProviderId: "pi"))
    XCTAssertFalse(provider.isCompatible(profileProviderId: "openai"))
    let linkableProfileProviders = ["anthropic", "pi", "openai"].filter {
      provider.isCompatible(profileProviderId: $0)
    }
    XCTAssertEqual(linkableProfileProviders, ["pi"])
    XCTAssertEqual(provider.policy.caveats.first?.kind, "privacy")

    let blocked = try XCTUnwrap(catalog.provider(id: "blocked-fixture"))
    XCTAssertFalse(blocked.canAcceptGenericAPIKey)
    XCTAssertNil(ProviderCatalogProfileOptions.modelProvider(for: blocked))
    XCTAssertFalse(blocked.isCompatible(profileProviderId: "pi"))
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

  func testLegacyCatalogProviderUsesOnlySchemaSupportedAdapter() throws {
    let catalog = try catalog()
    let options = ProviderCatalogProfileOptions.options(from: catalog)

    XCTAssertTrue(options.contains {
      $0.0 == .anthropic && $0.1 == "Synthetic Anthropic Adapter"
    })
    XCTAssertFalse(options.contains { $0.0.rawValue == "synthetic-legacy-product" })
    XCTAssertFalse(options.contains { $0.0.rawValue == "future-adapter" })

    let supported = try XCTUnwrap(catalog.provider(id: "synthetic-legacy-product"))
    XCTAssertEqual(ProviderCatalogProfileOptions.modelProvider(for: supported), .anthropic)
    let unsupported = try XCTUnwrap(catalog.provider(id: "unsupported-legacy-product"))
    XCTAssertNil(ProviderCatalogProfileOptions.modelProvider(for: unsupported))
  }

  func testSwitchingGenericAccountPreservesModelButBlocksSaveUntilCompatible() throws {
    let catalog = try catalog()
    let previousModel = "auto"

    let switchedOptions = RuntimeModelOptions.options(
      for: .pi,
      role: .defaultModel,
      currentValue: previousModel,
      catalog: catalog,
      providerId: "fixture-cloud"
    )
    XCTAssertEqual(switchedOptions.last?.value, previousModel)
    XCTAssertTrue(switchedOptions.last?.label.contains("unavailable") == true)
    XCTAssertNotNil(ProviderModelSaveEligibility.profileErrorMessage(
      profileProviderId: "pi",
      hasLinkedAccount: true,
      accountProviderId: "fixture-cloud",
      defaultModel: previousModel,
      reviewerModel: "fixture/model-a",
      catalog: catalog
    ))

    XCTAssertNil(ProviderModelSaveEligibility.profileErrorMessage(
      profileProviderId: "pi",
      hasLinkedAccount: true,
      accountProviderId: "fixture-cloud",
      defaultModel: "fixture/model-a",
      reviewerModel: "fixture/model-a",
      catalog: catalog
    ))
    XCTAssertNotNil(ProviderModelSaveEligibility.profileErrorMessage(
      profileProviderId: "pi",
      hasLinkedAccount: true,
      accountProviderId: "fixture-cloud",
      defaultModel: "fixture/model-a",
      reviewerModel: "another-provider/model",
      catalog: catalog
    ))
    XCTAssertNotNil(ProviderModelSaveEligibility.profileErrorMessage(
      profileProviderId: "pi",
      hasLinkedAccount: true,
      accountProviderId: nil,
      defaultModel: "fixture/model-a",
      reviewerModel: "fixture/model-a",
      catalog: catalog
    ))
    XCTAssertNotNil(ProviderModelSaveEligibility.profileErrorMessage(
      profileProviderId: "pi",
      hasLinkedAccount: false,
      accountProviderId: nil,
      defaultModel: "fixture/model-a",
      reviewerModel: "fixture/model-a",
      catalog: catalog
    ))
    XCTAssertNil(ProviderModelSaveEligibility.profileErrorMessage(
      profileProviderId: "pi",
      hasLinkedAccount: false,
      accountProviderId: nil,
      defaultModel: "auto",
      reviewerModel: "",
      catalog: catalog
    ))
  }

  @MainActor
  func testCatalogFailurePreservesCurrentSelection() async {
    let currentProvider = ModelProvider.pi
    let currentModel = "temporarily-unavailable/model"
    let result = await loadProviderCatalogForEditor(
      currentProvider: currentProvider,
      currentModel: currentModel,
      loader: {
        throw NSError(
          domain: "ProviderCatalogTests",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "daemon unavailable"]
        )
      }
    )
    XCTAssertEqual(result.provider, currentProvider)
    XCTAssertEqual(result.model, currentModel)
    XCTAssertNil(result.catalog)
    XCTAssertTrue(result.errorMessage?.contains("Provider catalog unavailable") == true)
    XCTAssertTrue(result.errorMessage?.contains("Current values are preserved") == true)

    let options = RuntimeModelOptions.options(
      for: .pi,
      role: .defaultModel,
      currentValue: result.model,
      catalog: result.catalog,
      providerId: "temporarily-unavailable"
    )
    XCTAssertEqual(options.last?.value, currentModel)
  }
}
