import SwiftUI
import AutopodClient

struct PodsitterSettingsView: View {
  let profileNames: [String]
  let openProviderAccounts: () -> Void

  @State private var store: PodsitterStore
  @State private var showDisableConfirmation = false

  init(
    api: DaemonAPI,
    profileNames: [String],
    openProviderAccounts: @escaping () -> Void
  ) {
    self.profileNames = profileNames
    self.openProviderAccounts = openProviderAccounts
    _store = State(initialValue: PodsitterStore(api: api))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      statusHeader
      if let error = store.error {
        errorBanner(error)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          authorityWarning
          decisionModel
          authorization
          providerStatus
          recentDecisions
        }
        .padding(.bottom, 8)
      }
    }
    .padding(20)
    .task {
      await store.load()
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(15))
        guard !Task.isCancelled else { return }
        await store.refreshStatusAndHistory()
      }
    }
    .alert("Disable daemon Podsitter?", isPresented: $showDisableConfirmation) {
      Button("Cancel", role: .cancel) {}
      Button("Disable Now", role: .destructive) {
        Task { await store.disableNow() }
      }
      .accessibilityLabel("Confirm disable daemon Podsitter now")
    } message: {
      Text(PodsitterStore.killSwitchConfirmation)
    }
  }

  private var statusHeader: some View {
    HStack(alignment: .center, spacing: 8) {
      Circle()
        .fill(statusColor)
        .frame(width: 9, height: 9)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text("Podsitter")
          .font(.title3.weight(.semibold))
        Text(store.stateLabel)
          .font(.callout)
          .foregroundStyle(.secondary)
          .accessibilityLabel("Podsitter state: \(store.stateLabel)")
      }
      Spacer()
      if store.isEnabled {
        Button("DISABLE NOW", role: .destructive) {
          showDisableConfirmation = true
        }
        .buttonStyle(.bordered)
        .tint(.red)
        .disabled(store.isSaving)
        .accessibilityLabel("Disable daemon Podsitter now")
        .accessibilityHint("Requires confirmation and invalidates in-flight Podsitter authority")
      }
    }
  }

  private var authorityWarning: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.shield.fill")
        .foregroundStyle(.orange)
        .accessibilityHidden(true)
      Text(PodsitterStore.fullAuthorityWarning)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(9)
    .background(Color.orange.opacity(0.1))
    .clipShape(RoundedRectangle(cornerRadius: 7))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Full Podsitter authority. \(PodsitterStore.fullAuthorityWarning)")
  }

  private var decisionModel: some View {
    GroupBox("Decision model") {
      Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
        GridRow {
          Text("Account")
          Picker("Dedicated provider account", selection: accountBinding) {
            Text("Choose account").tag("")
            ForEach(store.accounts, id: \.id) { account in
              Text(account.hasCredentials ? account.name : "\(account.name) · login required")
                .tag(account.id)
            }
          }
          .labelsHidden()
          .accessibilityLabel("Dedicated Podsitter provider account")
        }
        GridRow {
          Text("Runtime")
          HStack(spacing: 8) {
            Picker("Runtime", selection: runtimeBinding) {
              ForEach(store.compatibleRuntimes, id: \.self) { runtime in
                Text(runtime.rawValue.capitalized).tag(runtime)
              }
            }
            .labelsHidden()
            .accessibilityLabel("Compatible decision runtime")
            Picker("Model", selection: $store.selectedModel) {
              if store.compatibleModels.isEmpty {
                Text("No compatible models").tag("")
              }
              ForEach(store.compatibleModels, id: \.value) { model in
                Text(model.label).tag(model.value)
              }
            }
            .labelsHidden()
            .accessibilityLabel("Decision model")
          }
        }
      }
      if store.needsProviderAuthentication {
        Button("Manage provider account authentication") {
          openProviderAccounts()
        }
        .buttonStyle(.link)
        .font(.caption)
        .accessibilityHint("Opens Provider Accounts settings; login is not performed here")
      }
    }
  }

  private var authorization: some View {
    GroupBox("Authorization") {
      VStack(alignment: .leading, spacing: 9) {
        Picker("Activation", selection: $store.activationMode) {
          Text("Always on").tag(PodsitterActivationMode.always)
          Text("Recurring").tag(PodsitterActivationMode.recurring)
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("Podsitter activation schedule")

        if store.activationMode == .recurring {
          HStack(spacing: 8) {
            TextField("Cron expression", text: $store.cronExpression)
              .accessibilityLabel("Five-field recurring cron expression")
            TextField("Minutes", value: $store.durationMinutes, format: .number)
              .frame(width: 72)
              .accessibilityLabel("Recurring duration in minutes")
            TextField("Timezone", text: $store.timeZone)
              .accessibilityLabel("Recurring IANA timezone")
          }
          if !store.activationIsValid {
            Text("Recurring authorization requires a five-field cron, positive duration, and valid timezone.")
              .font(.caption)
              .foregroundStyle(.red)
              .accessibilityLabel("Invalid recurring authorization")
          }
        }

        HStack {
          Toggle("Optional expiry", isOn: $store.hasExpiry)
          if store.hasExpiry {
            DatePicker(
              "Authorization expiry",
              selection: $store.expiry,
              in: Date()...,
              displayedComponents: [.date, .hourAndMinute]
            )
            .labelsHidden()
            .accessibilityLabel("Podsitter authorization expiry")
          }
        }

        HStack {
          Toggle("All profiles", isOn: $store.allProfiles)
          if !store.allProfiles {
            Menu("Selected: \(store.selectedProfiles.count)") {
              ForEach(profileNames, id: \.self) { profile in
                Button {
                  if store.selectedProfiles.contains(profile) {
                    store.selectedProfiles.remove(profile)
                  } else {
                    store.selectedProfiles.insert(profile)
                  }
                } label: {
                  Label(
                    profile,
                    systemImage: store.selectedProfiles.contains(profile) ? "checkmark" : "circle"
                  )
                }
              }
            }
            .accessibilityLabel("Select Podsitter profile scope")
          }
          Spacer()
          Button("Save") { Task { await store.save() } }
            .disabled(!store.canSave)
            .accessibilityHint(store.canSave ? "Saves configuration disabled" : "Complete a valid target and authorization")
          Button(store.isEnabled ? "Save & Keep Enabled" : "Save & Enable") {
            Task { await store.save(enable: true) }
          }
          .buttonStyle(.borderedProminent)
          .disabled(!store.canEnable)
          .accessibilityLabel(store.isEnabled ? "Save Podsitter and keep enabled" : "Save and enable Podsitter")
        }
      }
    }
  }

  private var providerStatus: some View {
    GroupBox("Provider") {
      VStack(alignment: .leading, spacing: 7) {
        HStack {
          Text(store.providerLabel)
            .font(.callout)
            .foregroundStyle(store.isProviderAvailable ? Color.secondary : Color.orange)
            .accessibilityLabel("Decision provider: \(store.providerLabel)")
          Spacer()
          Button("Probe now") { Task { await store.probeNow() } }
            .disabled(store.isProbing || !store.isConfigured)
            .accessibilityLabel("Probe Podsitter decision provider now")
        }
        HStack {
          Text("Pending: \(store.deferredCount) · Last action: \(store.lastActionLabel)")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .accessibilityLabel(
              "Pending attention \(store.deferredCount). Last action \(store.lastActionLabel)"
            )
          Spacer()
          Button("Check now") { Task { await store.checkNow() } }
            .disabled(store.isChecking || !store.isConfigured)
            .accessibilityLabel("Reconcile Podsitter attention now")
        }
        if let configuration = store.status?.configuration {
          Text(authorizationSummary(configuration))
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .accessibilityLabel("Authorization status: \(authorizationSummary(configuration))")
        }
      }
    }
  }

  private var recentDecisions: some View {
    GroupBox("Recent decisions") {
      if store.decisions.isEmpty {
        Text("No decisions recorded.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        LazyVStack(alignment: .leading, spacing: 8) {
          ForEach(store.decisions) { record in
            decisionRow(record)
            if record.id != store.decisions.last?.id { Divider() }
          }
        }
      }
    }
  }

  private func decisionRow(_ record: PodsitterDecisionRecordResponse) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack {
        Text(shortDate(record.createdAt))
        Text("· \(record.podId)")
        Text("· \(record.decision?.action.replacingOccurrences(of: "_", with: " ") ?? "no decision")")
          .fontWeight(.medium)
        Spacer()
        Text(record.outcome.replacingOccurrences(of: "_", with: " "))
      }
      .font(.caption)
      if let decision = record.decision {
        Text(decision.reason)
          .font(.caption)
          .lineLimit(2)
        Text("Risk: \(decision.remainingRisk)")
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(2)
        Text("Evidence: \(decision.evidenceRefs.joined(separator: ", "))")
          .font(.caption2.monospaced())
          .foregroundStyle(.tertiary)
          .lineLimit(2)
      } else if let failure = record.failureCode {
        Text("Failure: \(failure)")
          .font(.caption2)
          .foregroundStyle(.red)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(decisionAccessibilityLabel(record))
  }

  private var accountBinding: Binding<String> {
    Binding(
      get: { store.selectedAccountId },
      set: { store.selectAccount($0) }
    )
  }

  private var runtimeBinding: Binding<PodsitterRuntime> {
    Binding(
      get: { store.selectedRuntime },
      set: { store.selectRuntime($0) }
    )
  }

  private var statusColor: Color {
    if !store.isEnabled { return .secondary }
    if !store.isCurrentlyActive || !store.isProviderAvailable { return .orange }
    return .green
  }

  private func authorizationSummary(_ configuration: PodsitterConfigurationResponse) -> String {
    var parts = [store.isCurrentlyActive ? "Currently active" : "Currently inactive"]
    if let expiry = configuration.authorizedUntil {
      parts.append("expires \(shortDate(expiry))")
    } else {
      parts.append("no expiry")
    }
    if let next = store.status?.activation?.windowStartedAt, !store.isCurrentlyActive {
      parts.append("window \(shortDate(next))")
    } else if let end = store.status?.activation?.windowEndsAt {
      parts.append("window ends \(shortDate(end))")
    } else if case let .recurring(cron, _, zone) = configuration.activation {
      parts.append("next window follows \(cron) · \(zone)")
    }
    return parts.joined(separator: " · ")
  }

  private func decisionAccessibilityLabel(_ record: PodsitterDecisionRecordResponse) -> String {
    guard let decision = record.decision else {
      return "\(record.podId), \(record.outcome), \(record.failureCode ?? "no decision")"
    }
    return "\(record.podId), \(decision.action), \(record.outcome). "
      + "\(decision.reason). Remaining risk: \(decision.remainingRisk). "
      + "Evidence: \(decision.evidenceRefs.joined(separator: ", "))"
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.yellow)
        .accessibilityHidden(true)
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Spacer()
      Button {
        store.error = nil
      } label: {
        Image(systemName: "xmark.circle.fill")
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Dismiss Podsitter error")
    }
    .padding(8)
    .background(Color.red.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: 6))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Podsitter error: \(message)")
  }

  private func shortDate(_ value: String) -> String {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    else { return value }
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
