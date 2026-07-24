import AutopodClient
import Foundation

enum ProviderCatalogProfileOptions {
    static func modelProvider(for provider: ProviderCatalogProvider) -> ModelProvider? {
        guard provider.policy.authorization == "supported", provider.policy.runnable else {
            return nil
        }
        if provider.implementation.kind == "generic-pi-api" {
            return provider.canAcceptGenericAPIKey ? .pi : nil
        }
        guard provider.implementation.kind == "legacy",
              let adapterId = provider.implementation.adapterId else {
            return nil
        }
        let legacyProvider = ModelProvider(rawValue: adapterId)
        return ModelProvider.legacyValues.contains(legacyProvider) ? legacyProvider : nil
    }

    static func options(from catalog: ProviderCatalogResponse) -> [(ModelProvider, String)] {
        let discovered = catalog.providers.compactMap { provider -> (ModelProvider, String)? in
            guard let modelProvider = modelProvider(for: provider) else { return nil }
            return (modelProvider, provider.displayName)
        }
        return Dictionary(grouping: discovered, by: \.0)
            .map { modelProvider, entries in
                (
                    modelProvider,
                    entries.map(\.1).sorted().joined(separator: " / ")
                )
            }
            .sorted { $0.1.localizedCaseInsensitiveCompare($1.1) == .orderedAscending }
    }
}
