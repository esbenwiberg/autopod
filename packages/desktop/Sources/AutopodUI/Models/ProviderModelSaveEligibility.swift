import AutopodClient

enum ProviderModelSaveEligibility {
    static func errorMessage(
        profileProviderId: String,
        accountProviderId: String?,
        model: String,
        catalog: ProviderCatalogResponse?
    ) -> String? {
        guard profileProviderId == "pi", let accountProviderId, accountProviderId != "pi" else {
            return nil
        }
        guard let provider = catalog?.provider(id: accountProviderId) else {
            return "Provider catalog unavailable. Keep the current selection, but reconnect before saving."
        }
        guard provider.implementation.kind == "generic-pi-api" else { return nil }
        guard provider.canAcceptGenericAPIKey else {
            return "\(provider.displayName) is not authorized for unattended pods."
        }
        let reviewedModel = catalog?.models.contains {
            $0.id == model && $0.providerId == provider.id && $0.lifecycle == "active"
        } == true
        guard reviewedModel else {
            return "Choose a reviewed \(provider.displayName) model before saving."
        }
        return nil
    }
}
