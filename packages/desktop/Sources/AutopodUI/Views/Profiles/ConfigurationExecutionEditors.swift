import AutopodClient
import SwiftUI

/// Explicit fields also work when the saved policy is null or absent.
struct ConfigurationNetworkPolicyEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  private var policy: Binding<[String: ConfigurationJSON]> {
    Binding(get: { fields["networkPolicy"]?.object ?? [:] }, set: { fields["networkPolicy"] = .object($0) })
  }
  private func flag(_ key: String, fallback: Bool = false) -> Binding<Bool> {
    Binding(get: { policy.wrappedValue[key]?.bool ?? fallback }, set: { policy.wrappedValue[key] = .bool($0) })
  }
  var body: some View {
    ConfigurationSection(title: "Outbound network access", subtitle: "Applies to future pods launched with this profile.") {
      Toggle("Customize network policy", isOn: Binding(get: { fields["networkPolicy"]?.object != nil }, set: { custom in
        fields["networkPolicy"] = custom
          ? .object(["enabled": .bool(true), "mode": .string("restricted"), "allowedHosts": .array([])])
          : .null
      })).accessibilityIdentifier("configuration-network-custom")
      if fields["networkPolicy"]?.object != nil {
        Toggle("Enable network isolation", isOn: flag("enabled"))
          .accessibilityIdentifier("configuration-network-enabled")
        if policy.wrappedValue["enabled"]?.bool == true {
          Picker("Outbound mode", selection: Binding(get: {
            policy.wrappedValue["mode"]?.string ?? "restricted"
          }, set: { policy.wrappedValue["mode"] = .string($0) })) {
            Text("Allow all").tag("allow-all")
            Text("Deny all").tag("deny-all")
            Text("Restricted to allowed hosts").tag("restricted")
          }.accessibilityIdentifier("configuration-network-mode")
          if (policy.wrappedValue["mode"]?.string ?? "restricted") == "restricted" {
            Toggle("Allow package managers", isOn: flag("allowPackageManagers"))
              .accessibilityIdentifier("configuration-network-packages")
            Text("Allow common npm, pip, NuGet, Cargo, apt, Go and RubyGems registries.")
              .font(.caption).foregroundStyle(.secondary)
            Toggle("Replace default allowed hosts", isOn: flag("replaceDefaults"))
              .accessibilityIdentifier("configuration-network-replace-defaults")
            Text("When off, custom hosts extend the daemon's default allowlist.")
              .font(.caption).foregroundStyle(.secondary)
            ConfigurationStringListEditor(title: "Allowed hosts", values: Binding(get: {
              policy.wrappedValue["allowedHosts"]?.array ?? []
            }, set: { policy.wrappedValue["allowedHosts"] = .array($0) }))
            Text("Enter hostnames such as api.example.com or *.example.com, one per row.")
              .font(.caption).foregroundStyle(.secondary)
          }
        } else {
          Text("Network isolation is disabled by this policy.").font(.caption).foregroundStyle(.secondary)
        }
      } else {
        Text("Use the daemon's default network policy.").font(.callout).foregroundStyle(.secondary)
      }
    }
  }
}

/// Unsupported saved limits stay visible and may be cleared, but cannot be enabled.
struct ConfigurationAllocationLimit: View {
  let title: String
  @Binding var fields: [String: ConfigurationJSON]
  let key: String
  let fallback: Double
  let supported: Bool
  let unavailable: String
  var body: some View {
    if supported {
      ConfigurationNumberValue(title: title, fields: $fields, key: key, fallback: fallback)
    } else if let saved = fields[key]?.number {
      HStack {
        Text("\(title): \(saved.formatted()) · unsupported").font(.callout).foregroundStyle(.orange)
        Button("Use backend default") { fields[key] = .null }
      }
      Text(unavailable).font(.caption).foregroundStyle(.secondary)
    } else {
      Text("\(title): backend managed").font(.callout).foregroundStyle(.secondary)
    }
  }
}

struct ConfigurationProfileSidecarsEditor: View {
  @Binding var payload: [String: ConfigurationJSON]
  let environment: ConfigurationDocument?
  let capabilities: ConfigurationJSON
  var editDefinitions: ((ConfigurationDocument) -> Void)?
  private var definitions: [[String: ConfigurationJSON]] {
    environment?.payload["sidecars"]?.array?.compactMap(\.object) ?? []
  }
  private var required: [String] { payload["requiredSidecarIds"]?.array?.compactMap(\.string) ?? [] }
  private var backend: ConfigurationJSON? {
    let target = payload["execution"]?["target"]?.string ?? "local"
    return capabilities["execution"]?.array?.first { $0["target"]?.string == target }
  }
  private var allocations: [String: ConfigurationJSON] { payload["execution"]?["sidecars"]?.object ?? [:] }
  private var missingIDs: [String] {
    Set(required + Array(allocations.keys)).subtracting(definitions.compactMap { $0["id"]?.string }).sorted()
  }
  private func requireSidecar(_ id: String, enabled: Bool) {
    var ids = required.filter { $0 != id }
    if enabled { ids.append(id) }
    payload["requiredSidecarIds"] = .array(ids.map(ConfigurationJSON.string))
  }
  private func allocation(_ id: String) -> Binding<[String: ConfigurationJSON]> {
    Binding(get: { allocations[id]?.object ?? [:] }, set: { value in
      var execution = payload["execution"]?.object ?? [:]
      var sidecars = execution["sidecars"]?.object ?? [:]
      sidecars[id] = .object(value)
      execution["sidecars"] = .object(sidecars)
      payload["execution"] = .object(execution)
    })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      ConfigurationSection(title: "Sidecar services", subtitle: "Choose which services start with this profile. Definitions are shared through the selected Environment.") {
        if let environment {
          HStack {
            Label(environment.name, systemImage: "shippingbox")
            Spacer()
            Button(definitions.isEmpty ? "Add sidecar definitions…" : "Edit sidecar definitions…") {
              editDefinitions?(environment)
            }.disabled(editDefinitions == nil).accessibilityIdentifier("configuration-sidecar-definitions")
          }
          if definitions.isEmpty {
            Text("No sidecars defined. Add PostgreSQL, Redis or Dagger in this Environment, then choose their profile defaults here.")
              .font(.callout).foregroundStyle(.secondary)
          }
        } else {
          Text("Choose an Environment in Composition to configure its sidecars.").foregroundStyle(.secondary)
        }
        if backend == nil {
          Text("Backend capabilities are unavailable. Saved selections and allocations are retained.")
            .font(.caption).foregroundStyle(.orange)
        } else if backend?["sidecars"]?.bool != true {
          Text("This execution backend does not support sidecars. Change the backend in Execution or remove required services before launching.")
            .font(.caption).foregroundStyle(.orange)
        }
        if let maximum = backend?["maxTotalMemoryGb"]?.number {
          Text("Main container and sidecars share a \(maximum.formatted()) GB memory limit.")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      ForEach(definitions, id: \.["id"]) { definition in
        let id = definition["id"]?.string ?? ""
        let type = definition["type"]?.string ?? "service"
        let startup = definition["startup"]?.string ?? "on-demand"
        let selected = startup == "always" || required.contains(id)
        let canStart = startup != "disabled" && backend?["sidecars"]?.bool == true
        ConfigurationSection(title: id, subtitle: "\(type) · \(definition["version"]?.string ?? "") · \(startup)") {
          if startup == "always" {
            Label("Always starts with this Environment", systemImage: "checkmark.circle.fill")
              .font(.callout).foregroundStyle(DesktopTheme.accent)
          } else {
            Toggle("Start with this profile", isOn: Binding(get: { required.contains(id) }, set: { requireSidecar(id, enabled: $0) }))
              .disabled(!canStart && !required.contains(id))
              .accessibilityIdentifier("configuration-sidecar-required-\(id)")
          }
          if startup == "disabled" {
            Text("Disabled in the Environment. Remove the profile requirement or enable the definition.")
              .font(.caption).foregroundStyle(.orange)
          }
          if type == "dagger-engine" {
            Text("Dagger also requires a trusted repository setup and host permission for privileged sidecars.")
              .font(.caption).foregroundStyle(.secondary)
          }
          if selected || allocations[id] != nil {
            allocationFields(id, type: type, canStart: canStart)
          }
        }
      }
      ForEach(missingIDs, id: \.self) { id in
        ConfigurationSection(title: "Unavailable sidecar · \(id)") {
          Text("This saved instance is not defined in the selected Environment. Its settings are retained until you remove them.")
            .font(.callout).foregroundStyle(.orange)
          Button("Remove unavailable sidecar", role: .destructive) {
            requireSidecar(id, enabled: false)
            var execution = payload["execution"]?.object ?? [:]
            var sidecars = execution["sidecars"]?.object ?? [:]
            sidecars.removeValue(forKey: id)
            execution["sidecars"] = .object(sidecars)
            payload["execution"] = .object(execution)
          }.accessibilityIdentifier("configuration-sidecar-remove-\(id)")
        }
      }
    }
  }
  private func allocationFields(_ id: String, type: String, canStart: Bool) -> some View {
    let fields = allocation(id)
    return VStack(alignment: .leading, spacing: 10) {
      ConfigurationAllocationLimit(title: "Memory (GB)", fields: fields, key: "memoryGb",
        fallback: backend?["sidecarDefaults"]?[type]?["memoryGb"]?.number ?? 1,
        supported: canStart, unavailable: "This backend cannot start this sidecar.")
      ConfigurationAllocationLimit(title: "CPUs", fields: fields, key: "cpus",
        fallback: backend?["sidecarDefaults"]?[type]?["cpus"]?.number ?? 1,
        supported: canStart && backend?["maxCpus"]?.number != nil,
        unavailable: "This backend cannot enforce an independent sidecar CPU limit.")
      ConfigurationAllocationLimit(title: "Storage (GB)", fields: fields, key: "storageGb", fallback: 10,
        supported: canStart && backend?["sidecarStorageLimit"]?.bool == true,
        unavailable: "This backend cannot enforce a sidecar storage limit.")
      Button("Use backend resource defaults") {
        var execution = payload["execution"]?.object ?? [:]
        var sidecars = execution["sidecars"]?.object ?? [:]
        sidecars.removeValue(forKey: id)
        execution["sidecars"] = .object(sidecars)
        payload["execution"] = .object(execution)
      }.accessibilityIdentifier("configuration-sidecar-reset-\(id)")
    }
  }
}
