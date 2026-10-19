import AutopodClient
import SwiftUI

struct PimSelectionSheet: View {
  @Environment(\.dismiss) private var dismiss
  let discover: (Bool) async throws -> ConfigurationJSON
  let onSave: ([[String: ConfigurationJSON]]) -> Void
  @State private var selections: [[String: ConfigurationJSON]]
  @State private var discovery: ConfigurationJSON?
  @State private var search = ""
  @State private var loading = false
  @State private var error: String?
  /// `cached` renders immediately; the sheet still revalidates on open (stale-while-revalidate).
  init(selected: [[String: ConfigurationJSON]], cached: ConfigurationJSON? = nil,
       discover: @escaping (Bool) async throws -> ConfigurationJSON,
       onSave: @escaping ([[String: ConfigurationJSON]]) -> Void) {
    self._selections = State(initialValue: selected); self._discovery = State(initialValue: cached)
    self.discover = discover; self.onSave = onSave
  }
  private var discoveredAt: Date? {
    guard let raw = discovery?["discoveredAt"]?.string else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: raw) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: raw)
  }
  private func load(fresh: Bool) async {
    loading = true; error = nil
    defer { loading = false }
    do { discovery = try await discover(fresh) } catch { self.error = error.localizedDescription }
  }
  /// Why a saved selection is missing from the list; nil while nothing has been discovered yet.
  private func missingReason(_ selection: [String: ConfigurationJSON]) -> String? {
    guard discovery != nil || (!loading && error != nil) else { return nil }
    let familyDown = discovery == nil || families.contains {
      $0["type"]?.string == selection["type"]?.string && $0["available"]?.bool == false
    }
    return familyDown ? "could not be verified" : "unavailable in current discovery"
  }
  private var families: [ConfigurationJSON] { discovery?["families"]?.array ?? [] }
  private var entries: [ConfigurationJSON] { families.flatMap { $0["assignments"]?.array ?? [] } }
  private var invalidSelection: String? {
    for selection in selections {
      let label = selection["displayName"]?.string ?? "Selected role"
      if (selection["justification"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Add a justification for \(label)." }
      let duration = selection["duration"]?.string ?? ""
      guard duration.range(of: #"^PT[1-9][0-9]*(H|M)$"#, options: .regularExpression) != nil,
            let amount = Double(duration.dropFirst(2).dropLast()) else { return "Use a duration such as PT1H or PT30M for \(label)." }
      if let entry = entries.first(where: { identity($0) == identity(.object(selection)) }),
         let maximum = entry["maximumDurationMinutes"]?.number,
         amount * (duration.hasSuffix("H") ? 60 : 1) > maximum { return "\(label) allows up to \(Int(maximum)) minutes." }
    }
    return nil
  }
  private func identity(_ value: ConfigurationJSON) -> String {
    ["tenantId", "principalId", "type", "eligibilityId", "roleId", "scope"].map { value[$0]?.string ?? "" }.joined(separator: "|")
  }
  private func selectedIndex(_ value: ConfigurationJSON) -> Int? { selections.firstIndex { identity(.object($0)) == identity(value) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Choose eligible PIM access").font(.title2.bold())
      Text("Same configured account. Saving selections does not activate access.").foregroundStyle(.secondary)
      HStack {
        TextField("Search roles and scopes", text: $search).textFieldStyle(.roundedBorder)
        if loading && discovery != nil { ProgressView().controlSize(.small) }
        if let discoveredAt { Text("Updated \(Text(discoveredAt, style: .relative)) ago").font(.caption).foregroundStyle(.secondary).fixedSize() }
        Button { Task { await load(fresh: true) } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
          .disabled(loading).help("Re-read eligibility from Entra, bypassing the daemon's cache")
      }
      if loading && discovery == nil { ProgressView("Loading eligible assignments…") }
      if let error { Text(error).foregroundStyle(.red) }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          ForEach(Array(families.enumerated()), id: \.offset) { _, family in
            if family["available"]?.bool == false { Text("\(family["type"]?.string ?? "Access"): \(family["reason"]?.string ?? "Unavailable")").font(.caption).foregroundStyle(.secondary) }
          }
          ForEach(Array(entries.filter { entry in search.isEmpty || "\(entry["displayName"]?.string ?? "") \(entry["scopeName"]?.string ?? "")".localizedCaseInsensitiveContains(search) }.enumerated()), id: \.offset) { _, entry in
            GroupBox {
              VStack(alignment: .leading, spacing: 8) {
                Toggle(isOn: Binding(get: { selectedIndex(entry) != nil }, set: { enabled in toggle(entry, enabled: enabled) })) {
                  VStack(alignment: .leading) {
                    Text(entry["displayName"]?.string ?? "Role").font(.headline)
                    Text(entry["scopeName"]?.string ?? entry["scope"]?.string ?? "").font(.caption).foregroundStyle(.secondary)
                  }
                }.disabled(entry["maximumDurationMinutes"]?.number == nil && selectedIndex(entry) == nil)
                if entry["maximumDurationMinutes"]?.number == nil { Text(entry["policyUnavailableReason"]?.string ?? "Duration policy is unavailable. This assignment cannot be newly selected.").font(.caption).foregroundStyle(.secondary) }
                if let index = selectedIndex(entry) {
                  Picker("Activate", selection: stringBinding(index, "timing", default: "when-needed")) {
                    Text("When requested").tag("when-needed"); Text("At startup").tag("startup")
                  }
                  HStack {
                    Text("Duration")
                    TextField("PT1H", text: stringBinding(index, "duration", default: "PT1H")).frame(width: 90)
                    if let maximum = entry["maximumDurationMinutes"]?.number { Text("Up to \(Int(maximum)) minutes").font(.caption).foregroundStyle(.secondary) }
                  }
                  TextField("Justification", text: stringBinding(index, "justification", default: ""))
                  DisclosureGroup("Exact scope") { Text(entry["scope"]?.string ?? "").font(.caption).textSelection(.enabled) }
                }
              }.padding(5)
            }
          }
          ForEach(Array(selections.enumerated()), id: \.offset) { index, selection in
            if !entries.contains(where: { identity($0) == identity(.object(selection)) }), let reason = missingReason(selection) {
              HStack { Text("\(selection["displayName"]?.string ?? "Saved assignment") · \(reason)").foregroundStyle(.orange); Spacer(); Button("Remove") { selections.remove(at: index) } }
            }
          }
        }
      }
      if let invalidSelection { Text(invalidSelection).font(.caption).foregroundStyle(.orange) }
      HStack { Button("Cancel") { dismiss() }; Spacer(); Text("\(selections.count) selected").foregroundStyle(.secondary); Button("Use selections") { onSave(selections); dismiss() }.buttonStyle(.borderedProminent).disabled((loading && discovery == nil) || invalidSelection != nil) }
    }.padding(24).frame(width: 660, height: 640)
    .task { await load(fresh: false) }
  }
  private func stringBinding(_ index: Int, _ key: String, default fallback: String) -> Binding<String> {
    Binding(get: { selections.indices.contains(index) ? selections[index][key]?.string ?? fallback : fallback },
      set: { if selections.indices.contains(index) { selections[index][key] = .string($0) } })
  }
  private func toggle(_ entry: ConfigurationJSON, enabled: Bool) {
    if let index = selectedIndex(entry) { if !enabled { selections.remove(at: index) }; return }
    guard enabled, let maximum = entry["maximumDurationMinutes"]?.number, maximum >= 1 else { return }
    var selection: [String: ConfigurationJSON] = [:]
    for key in ["type", "tenantId", "principalId", "eligibilityId", "roleId", "scope", "displayName"] { selection[key] = entry[key] }
    selection["timing"] = .string("when-needed"); selection["duration"] = .string("PT\(min(Int(maximum), 60))M"); selection["justification"] = .string("")
    selections.append(selection)
  }
}
