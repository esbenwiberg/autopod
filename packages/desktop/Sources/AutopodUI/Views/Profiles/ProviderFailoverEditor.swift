import SwiftUI
import AutopodClient

public enum ProviderFailoverTargetEligibility {
    public static func compatibleRuntime(
        for account: PublicProviderAccountResponse
    ) -> String? {
        switch account.provider {
        case "anthropic", "max": return "claude"
        case "openai", "openrouter": return "codex"
        case "copilot": return "copilot"
        case "pi": return "pi"
        default: return nil
        }
    }

    public static func isEligible(_ account: PublicProviderAccountResponse) -> Bool {
        account.hasCredentials && compatibleRuntime(for: account) != nil
    }
}

public func validateProviderFailoverPolicy(
    _ policy: ProviderFailoverPolicyResponse,
    accounts: [PublicProviderAccountResponse],
    excludedAccountId: String?
) -> String? {
    if policy.targets.count > 8 {
        return "Failover chains can contain at most 8 targets."
    }
    let ids = policy.targets.map(\.providerAccountId)
    if Set(ids).count != ids.count {
        return "Each provider account can appear only once."
    }
    if let excludedAccountId, ids.contains(excludedAccountId) {
        return "A provider account cannot fail over to itself."
    }
    for (index, target) in policy.targets.enumerated() {
        guard let account = accounts.first(where: { $0.id == target.providerAccountId }) else {
            return "Target \(index + 1) references an unavailable provider account."
        }
        guard ProviderFailoverTargetEligibility.isEligible(account),
              let runtime = ProviderFailoverTargetEligibility.compatibleRuntime(for: account)
        else {
            return "\(account.name) is not authenticated or its runtime cannot be selected safely."
        }
        if runtime != target.runtime {
            return "\(account.name) is incompatible with the selected runtime."
        }
        if target.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Target \(index + 1) needs a model."
        }
    }
    if let maxHops = policy.maxHops,
       maxHops < 1 || maxHops > policy.targets.count {
        return "Maximum hops must be between 1 and the number of targets."
    }
    return nil
}

/// Ordered editor for complete provider-account/runtime/model failover targets.
public struct ProviderFailoverEditor: View {
    @Binding private var policy: ProviderFailoverPolicyResponse
    private let accounts: [PublicProviderAccountResponse]
    private let excludedAccountId: String?
    private let isLoading: Bool
    private let loadError: String?

    public init(
        policy: Binding<ProviderFailoverPolicyResponse>,
        accounts: [PublicProviderAccountResponse],
        excludedAccountId: String? = nil,
        isLoading: Bool = false,
        loadError: String? = nil
    ) {
        self._policy = policy
        self.accounts = accounts
        self.excludedAccountId = excludedAccountId
        self.isLoading = isLoading
        self.loadError = loadError
    }

    public var validationMessage: String? {
        validateProviderFailoverPolicy(
            policy,
            accounts: accounts,
            excludedAccountId: excludedAccountId
        )
    }

    private var availableAccounts: [PublicProviderAccountResponse] {
        accounts
            .filter { $0.id != excludedAccountId && accountIsEligible($0) }
            .sorted {
                if $0.name == $1.name { return $0.id < $1.id }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if isLoading && accounts.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.65)
                    Text("Loading eligible provider accounts…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let loadError {
                inlineMessage(loadError, color: .red, icon: "exclamationmark.triangle.fill")
            } else if availableAccounts.isEmpty {
                inlineMessage(
                    "No authenticated, compatible alternate provider accounts are available.",
                    color: .secondary,
                    icon: "info.circle"
                )
            }

            ForEach(Array(policy.targets.enumerated()), id: \.offset) { index, target in
                targetRow(index: index, target: target)
            }

            if policy.targets.isEmpty && !isLoading {
                Text("No automatic failover targets configured.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            HStack {
                Button {
                    addTarget()
                } label: {
                    Label("Add failover target", systemImage: "plus")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(nextAvailableAccount == nil || policy.targets.count >= 8)

                Spacer()

                if !policy.targets.isEmpty {
                    Stepper(
                        "Maximum hops: \(policy.maxHops ?? policy.targets.count)",
                        value: maxHopsBinding,
                        in: 1...policy.targets.count
                    )
                    .font(.caption)
                    .fixedSize()
                }
            }

            if let validationMessage {
                inlineMessage(validationMessage, color: .red, icon: "exclamationmark.triangle.fill")
            }
        }
    }

    private func targetRow(index: Int, target: ProviderFailoverTargetResponse) -> some View {
        HStack(spacing: 8) {
            Text("\(index + 1).")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 20, alignment: .trailing)

            Picker("Account", selection: targetBinding(index, \.providerAccountId)) {
                ForEach(accountOptions(for: target), id: \.id) { account in
                    Text("\(account.name) · \(providerLabel(account.provider))").tag(account.id)
                }
            }
            .labelsHidden()
            .frame(width: 205)
            .onChange(of: policy.targets[index].providerAccountId) { _, accountId in
                guard let account = accounts.first(where: { $0.id == accountId }),
                      let runtime = compatibleRuntime(for: account) else { return }
                policy.targets[index].runtime = runtime
            }

            Picker("Runtime", selection: targetBinding(index, \.runtime)) {
                Text(runtimeLabel(target.runtime)).tag(target.runtime)
            }
            .labelsHidden()
            .frame(width: 90)
            .disabled(true)

            TextField("Model", text: targetBinding(index, \.model))
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 130)

            Button { move(index, by: -1) } label: {
                Image(systemName: "arrow.up")
            }
            .buttonStyle(.borderless)
            .disabled(index == 0)
            .help("Move target up")

            Button { move(index, by: 1) } label: {
                Image(systemName: "arrow.down")
            }
            .buttonStyle(.borderless)
            .disabled(index == policy.targets.count - 1)
            .help("Move target down")

            Button { remove(index) } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .help("Remove target")
        }
    }

    private func targetBinding(
        _ index: Int,
        _ keyPath: WritableKeyPath<ProviderFailoverTargetResponse, String>
    ) -> Binding<String> {
        Binding(
            get: { policy.targets[index][keyPath: keyPath] },
            set: { policy.targets[index][keyPath: keyPath] = $0 }
        )
    }

    private var maxHopsBinding: Binding<Int> {
        Binding(
            get: { policy.maxHops ?? policy.targets.count },
            set: { policy.maxHops = $0 == policy.targets.count ? nil : $0 }
        )
    }

    private var nextAvailableAccount: PublicProviderAccountResponse? {
        availableAccounts.first { candidate in
            !policy.targets.contains { $0.providerAccountId == candidate.id }
        }
    }

    private func addTarget() {
        guard let account = nextAvailableAccount,
              let runtime = compatibleRuntime(for: account) else { return }
        policy.targets.append(
            ProviderFailoverTargetResponse(
                providerAccountId: account.id,
                runtime: runtime,
                model: defaultModel(for: account.provider)
            )
        )
    }

    private func remove(_ index: Int) {
        policy.targets.remove(at: index)
        if let maxHops = policy.maxHops, maxHops > policy.targets.count {
            policy.maxHops = policy.targets.isEmpty ? nil : policy.targets.count
        }
    }

    private func move(_ index: Int, by offset: Int) {
        let destination = index + offset
        guard policy.targets.indices.contains(destination) else { return }
        policy.targets.swapAt(index, destination)
    }

    private func accountOptions(
        for target: ProviderFailoverTargetResponse
    ) -> [PublicProviderAccountResponse] {
        var options = availableAccounts.filter { candidate in
            candidate.id == target.providerAccountId ||
                !policy.targets.contains { $0.providerAccountId == candidate.id }
        }
        if let current = accounts.first(where: { $0.id == target.providerAccountId }),
           !options.contains(where: { $0.id == current.id }) {
            options.append(current)
        }
        return options
    }

    private func accountIsEligible(_ account: PublicProviderAccountResponse) -> Bool {
        ProviderFailoverTargetEligibility.isEligible(account)
    }

    private func compatibleRuntime(for account: PublicProviderAccountResponse) -> String? {
        ProviderFailoverTargetEligibility.compatibleRuntime(for: account)
    }

    private func defaultModel(for provider: String) -> String {
        switch provider {
        case "copilot": return "auto"
        default: return ""
        }
    }

    private func providerLabel(_ provider: String) -> String {
        switch provider {
        case "max": return "Claude Max"
        case "openai": return "OpenAI"
        case "openrouter": return "OpenRouter"
        case "copilot": return "Copilot"
        case "pi": return "Pi"
        case "anthropic": return "Anthropic"
        default: return provider.capitalized
        }
    }

    private func runtimeLabel(_ runtime: String) -> String {
        switch runtime {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "copilot": return "Copilot"
        case "pi": return "Pi"
        default: return runtime
        }
    }

    private func inlineMessage(_ message: String, color: Color, icon: String) -> some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: icon)
            Text(message).fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption2)
        .foregroundStyle(color)
    }
}
