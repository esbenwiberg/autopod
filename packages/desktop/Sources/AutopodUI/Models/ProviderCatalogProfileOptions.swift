import AutopodClient

enum ProviderCatalogProfileOptions {
    static func modelProvider(for provider: ProviderCatalogProvider) -> ModelProvider? {
        guard provider.implementation.kind == "legacy",
              provider.policy.authorization == "supported",
              provider.policy.runnable,
              let adapterId = provider.implementation.adapterId else {
            return nil
        }
        let modelProvider = ModelProvider(rawValue: adapterId)
        return ModelProvider.legacyValues.contains(modelProvider) ? modelProvider : nil
    }

    static func options(from catalog: ProviderCatalogResponse) -> [(ModelProvider, String)] {
        catalog.providers.compactMap { provider in
            guard let modelProvider = modelProvider(for: provider) else { return nil }
            return (modelProvider, provider.displayName)
        }
    }
}
