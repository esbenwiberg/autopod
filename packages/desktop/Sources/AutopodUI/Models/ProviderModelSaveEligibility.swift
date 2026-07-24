import AutopodClient

enum ProviderModelSaveEligibility {
    static func profileErrorMessage(
        profileProviderId: String,
        hasLinkedAccount: Bool,
        accountProviderId: String?,
        defaultModel: String,
        reviewerModel: String,
        catalog: ProviderCatalogResponse?
    ) -> String? {
        let defaultError = errorMessage(
            profileProviderId: profileProviderId,
            hasLinkedAccount: hasLinkedAccount,
            accountProviderId: accountProviderId,
            model: defaultModel,
            catalog: catalog
        )
        if let defaultError { return defaultError }
        guard !reviewerModel.isEmpty else { return nil }
        return errorMessage(
            profileProviderId: profileProviderId,
            hasLinkedAccount: hasLinkedAccount,
            accountProviderId: accountProviderId,
            model: reviewerModel,
            catalog: catalog
        )
    }

    static func errorMessage(
        profileProviderId: String,
        hasLinkedAccount: Bool,
        accountProviderId: String?,
        model: String,
        catalog: ProviderCatalogResponse?
    ) -> String? {
        guard profileProviderId == "pi" else { return nil }
        guard hasLinkedAccount else {
            let modelProviderId = catalog?.models.first(where: { $0.id == model })?.providerId
            let modelProvider = modelProviderId.flatMap { catalog?.provider(id: $0) }
            guard modelProvider?.implementation.kind == "generic-pi-api" else { return nil }
            return "Link a \(modelProvider?.displayName ?? "provider") account before saving."
        }
        guard let accountProviderId else {
            return "Provider account unavailable. Keep the current selection, but reconnect before saving."
        }
        guard accountProviderId != "pi" else { return nil }
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
