import AutopodClient
import Foundation

struct ProviderAccountsCatalogFailure {
  let accounts: [PublicProviderAccountResponse]
  let catalog: ProviderCatalogResponse? = nil
  let errorMessage: String

  init(preserving accounts: [PublicProviderAccountResponse], error: Error) {
    self.accounts = accounts
    self.errorMessage =
      "Provider catalog unavailable: \(error.localizedDescription). "
      + "Existing accounts and profile selections are preserved; refresh to manage credentials."
  }
}
