import AutopodClient
import Foundation

struct ProviderAccountsCatalogFailure {
  let accounts: [PublicProviderAccountResponse]
  let catalog: ProviderCatalogResponse?
  let errorMessage: String

  init(
    preserving accounts: [PublicProviderAccountResponse],
    catalog: ProviderCatalogResponse? = nil,
    error: Error
  ) {
    self.accounts = accounts
    self.catalog = catalog
    self.errorMessage =
      "Provider catalog unavailable: \(error.localizedDescription). "
      + "Existing accounts and profile selections are preserved; refresh to manage credentials."
  }
}
