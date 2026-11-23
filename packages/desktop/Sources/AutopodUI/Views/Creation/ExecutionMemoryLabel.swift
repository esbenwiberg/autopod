import AutopodClient

/// Display text for a main-container memory choice. Hosted sandboxes sell fixed bundles, so the
/// daemon advertises each bundle (`memoryBundles`) next to its memory tier; show that label instead
/// of a bare RAM figure. Targets without bundles (Docker) keep the plain "N GB" text.
internal enum ExecutionMemoryLabel {
  static func text(memoryGb: Double, backend: ConfigurationJSON?) -> String {
    let bundle = backend?["memoryBundles"]?.array?.first { $0["memoryGb"]?.number == memoryGb }
    return bundle?["label"]?.string ?? "\(memoryGb.formatted()) GB"
  }

  /// The advertised capabilities entry for an execution target.
  static func backend(_ capabilities: ConfigurationJSON, target: String?) -> ConfigurationJSON? {
    guard let target else { return nil }
    return capabilities["execution"]?.array?.first { $0["target"]?.string == target }
  }
}
