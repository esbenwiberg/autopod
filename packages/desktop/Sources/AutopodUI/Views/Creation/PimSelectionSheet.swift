import AutopodClient
import SwiftUI

struct PimSelectionSheet: View {
  @Environment(\.dismiss) private var dismiss
  let discover: () async throws -> ConfigurationJSON
  let onSave: ([[String: ConfigurationJSON]]) -> Void
  @State private var selections: [[String: ConfigurationJSON]]
  @State private var discovery: ConfigurationJSON?
  @State private var search = ""
  @State private var loading = true
  @State private var error: String?
  init(selected: [[String: ConfigurationJSON]], discover: @escaping () async throws -> ConfigurationJSON,
       onSave: @escaping ([[String: ConfigurationJSON]]) -> Void) {
    self._selections = State(initialValue: selected); self.discover = discover; self.onSave = onSave
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
      TextField("Search roles and scopes", text: $search).textFieldStyle(.roundedBorder)
      if loading { ProgressView("Loading eligible assignments…") }
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
            if !entries.contains(where: { identity($0) == identity(.object(selection)) }) {
              HStack { Text("\(selection["displayName"]?.string ?? "Saved assignment") · unavailable in current discovery").foregroundStyle(.orange); Spacer(); Button("Remove") { selections.remove(at: index) } }
            }
          }
        }
      }
      if let invalidSelection { Text(invalidSelection).font(.caption).foregroundStyle(.orange) }
      HStack { Button("Cancel") { dismiss() }; Spacer(); Text("\(selections.count) selected").foregroundStyle(.secondary); Button("Use selections") { onSave(selections); dismiss() }.buttonStyle(.borderedProminent).disabled(loading || invalidSelection != nil) }
    }.padding(24).frame(width: 660, height: 640)
    .task { do { discovery = try await discover() } catch { self.error = error.localizedDescription }; loading = false }
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
