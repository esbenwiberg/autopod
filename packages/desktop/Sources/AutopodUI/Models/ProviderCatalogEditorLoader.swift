import AutopodClient
import Foundation

struct ProviderCatalogEditorLoadResult: Sendable {
    let catalog: ProviderCatalogResponse?
    let errorMessage: String?
    let provider: ModelProvider
    let model: String
}

@MainActor
func loadProviderCatalogForEditor(
    currentProvider: ModelProvider,
    currentModel: String,
    loader: (() async throws -> ProviderCatalogResponse)?
) async -> ProviderCatalogEditorLoadResult {
    guard let loader else {
        return ProviderCatalogEditorLoadResult(
            catalog: nil,
            errorMessage: "Provider catalog unavailable while offline. Current values are preserved.",
            provider: currentProvider,
            model: currentModel
        )
    }
    do {
        return ProviderCatalogEditorLoadResult(
            catalog: try await loader(),
            errorMessage: nil,
            provider: currentProvider,
            model: currentModel
        )
    } catch {
        return ProviderCatalogEditorLoadResult(
            catalog: nil,
            errorMessage: "Provider catalog unavailable: \(error.localizedDescription). Current values are preserved.",
            provider: currentProvider,
            model: currentModel
        )
    }
}
