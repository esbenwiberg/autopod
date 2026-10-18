import AutopodClient
import SwiftUI

/// Nested edits retain fields owned by newer daemons and unrelated policy settings.
private func workflowObject(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String) -> Binding<[String: ConfigurationJSON]> {
  Binding(get: { fields.wrappedValue[key]?.object ?? [:] }, set: { fields.wrappedValue[key] = .object($0) })
}
private func workflowFlag(_ fields: Binding<[String: ConfigurationJSON]>, _ key: String, fallback: Bool = false) -> Binding<Bool> {
  Binding(get: { fields.wrappedValue[key]?.bool ?? fallback }, set: { fields.wrappedValue[key] = .bool($0) })
}

struct ConfigurationWorkflowFraction: View {
  let title: String
  let id: String
  @Binding var fields: [String: ConfigurationJSON]
  let key: String
  let fallback: Double
  let range: ClosedRange<Double>
  var sliderWidth: CGFloat = 220
  var body: some View {
    HStack {
      Text(title)
      Slider(value: Binding(get: { fields[key]?.number ?? fallback }, set: { fields[key] = .number($0) }), in: range)
        .frame(maxWidth: sliderWidth).accessibilityLabel(title).accessibilityIdentifier(id)
      TextField(title, value: Binding(get: { fields[key]?.number ?? fallback }, set: {
        fields[key] = .number(min(range.upperBound, max(range.lowerBound, $0)))
      }), format: .percent.precision(.fractionLength(0...2)))
        .monospacedDigit().frame(width: 80).accessibilityIdentifier("\(id)-value")
    }
  }
}

/// A formatter accepts the schema's full integer range, including saved custom timeouts.
private struct ConfigurationWorkflowInteger: View {
  let title: String
  let id: String
  @Binding var fields: [String: ConfigurationJSON]
  let key: String
  let fallback: Int
  let range: ClosedRange<Int>
  private var formatter: NumberFormatter {
    let value = NumberFormatter()
    value.numberStyle = .decimal; value.usesGroupingSeparator = false; value.allowsFloats = false
    value.minimum = NSNumber(value: range.lowerBound); value.maximum = NSNumber(value: range.upperBound)
    return value
  }
  var body: some View {
    LabeledContent(title) {
      TextField(title, value: Binding(get: { Int(fields[key]?.number ?? Double(fallback)) }, set: { fields[key] = .number(Double($0)) }), formatter: formatter)
        .frame(width: 110).accessibilityIdentifier(id)
      Text("\(range.lowerBound)–\(range.upperBound)").font(.caption).foregroundStyle(.secondary)
    }
  }
}

struct ConfigurationWorkflowEscalationEditor: View {
  @Binding var payload: [String: ConfigurationJSON]
  private var policy: Binding<[String: ConfigurationJSON]> { workflowObject($payload, "escalation") }
  var body: some View {
    ConfigurationSection(title: "Escalation policy", subtitle: "AI consultation uses the reviewer in the selected AI setup.") {
      Toggle("Customize escalation", isOn: Binding(get: { payload["escalation"]?.object != nil }, set: {
        payload["escalation"] = $0 ? .object([:]) : .null
      })).accessibilityIdentifier("workflow-escalation-custom")
      if payload["escalation"]?.object != nil {
        Toggle("Allow asking a human", isOn: workflowFlag(policy, "askHuman", fallback: true))
          .accessibilityIdentifier("workflow-ask-human")
        Toggle("Allow AI consultation", isOn: workflowFlag(workflowObject(policy, "askAi"), "enabled"))
          .accessibilityIdentifier("workflow-ask-ai")
        ConfigurationWorkflowInteger(title: "AI consultation limit", id: "workflow-ai-limit", fields: workflowObject(policy, "askAi"), key: "maxCalls", fallback: 5, range: 0...50)
        Toggle("Proactive AI advisor", isOn: workflowFlag(workflowObject(policy, "advisor"), "enabled"))
          .accessibilityIdentifier("workflow-advisor")
        ConfigurationWorkflowInteger(title: "Pause after blockers", id: "workflow-blockers", fields: policy, key: "autoPauseAfter", fallback: 3, range: 1...20)
        Divider()
        ConfigurationWorkflowInteger(title: "Human response timeout (seconds)", id: "workflow-human-timeout", fields: policy, key: "humanResponseTimeout", fallback: 3600, range: 60...86400)
        Picker("If nobody responds", selection: Binding(get: { policy.wrappedValue["askHumanOnTimeout"]?.string ?? "continue" }, set: { policy.wrappedValue["askHumanOnTimeout"] = .string($0) })) {
          Text("Continue with best judgement").tag("continue")
          Text("Ask the AI reviewer").tag("ask_ai")
        }.accessibilityIdentifier("workflow-human-timeout-action")
      } else {
        Text("Use daemon defaults: human questions allowed, AI consultation and advisor off, pause after 3 blockers, and wait 1 hour for a human.")
          .font(.callout).foregroundStyle(.secondary)
      }
    }
  }
}

struct ConfigurationWorkflowSecurityEditor: View {
  @Binding var payload: [String: ConfigurationJSON]
  private var policy: Binding<[String: ConfigurationJSON]> { workflowObject($payload, "securityScan") }
  /// Matches the daemon's default scan preset; only materialized on explicit customization.
  static var initialPolicy: [String: ConfigurationJSON] {
    ["detectors": .object([
      "secrets": .object(["enabled": .bool(true)]),
      "pii": .object(["enabled": .bool(false), "threshold": .number(0.7)]),
      "injection": .object(["enabled": .bool(false), "threshold": .number(0.8)]),
    ]), "provisioning": checkpoint(scope: "auto", secret: "warn"), "push": checkpoint(scope: "diff", secret: "block")]
  }
  private static func checkpoint(scope: String, secret: String) -> ConfigurationJSON {
    .object(["enabled": .bool(true), "scope": .string(scope), "onSecret": .string(secret), "onPii": .string("warn"), "onInjection": .string("warn")])
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ConfigurationSection(title: "Security scans", subtitle: "Scan repository content before work starts and before changes are pushed.") {
        Toggle("Customize security scans", isOn: Binding(get: { payload["securityScan"]?.object != nil }, set: {
          payload["securityScan"] = $0 ? .object(Self.initialPolicy) : .null
        })).accessibilityIdentifier("workflow-security-custom")
        if payload["securityScan"]?.object == nil {
          Text("Use the daemon's default scan policy. Customizing starts with that policy; turning customization off restores daemon defaults.")
            .font(.callout).foregroundStyle(.secondary)
        } else {
          detector("Secrets", key: "secrets")
          detector("Personal data", key: "pii", threshold: 0.7)
          detector("Prompt injection", key: "injection", threshold: 0.8)
        }
      }
      if payload["securityScan"]?.object != nil {
        ViewThatFits(in: .horizontal) {
          HStack(alignment: .top, spacing: 12) { checkpointEditor("Before work starts", key: "provisioning"); checkpointEditor("Before push", key: "push") }
          VStack(spacing: 12) { checkpointEditor("Before work starts", key: "provisioning"); checkpointEditor("Before push", key: "push") }
        }
        ConfigurationSection(title: "Always-scanned paths", subtitle: "Repository-relative globs included even during diff scans.") {
          Toggle("Customize paths", isOn: Binding(get: { policy.wrappedValue["alwaysScanPaths"]?.array != nil }, set: {
            if $0 { policy.wrappedValue["alwaysScanPaths"] = .array([]) }
            else { policy.wrappedValue.removeValue(forKey: "alwaysScanPaths") }
          })).accessibilityIdentifier("workflow-scan-paths-custom")
          if policy.wrappedValue["alwaysScanPaths"]?.array != nil {
            ConfigurationStringListEditor(title: "Paths", values: Binding(get: { policy.wrappedValue["alwaysScanPaths"]?.array ?? [] }, set: { policy.wrappedValue["alwaysScanPaths"] = .array($0) }))
            Text("An empty list disables the default always-scanned paths. Up to 64 paths, each 1–256 characters.").font(.caption).foregroundStyle(.secondary)
          } else {
            Text("Daemon defaults include agent instructions, README and architecture files.").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
    }
  }
  private func detector(_ title: String, key: String, threshold: Double? = nil) -> some View {
    let fields = workflowObject(workflowObject(policy, "detectors"), key)
    return HStack(spacing: 12) {
      Toggle(title, isOn: workflowFlag(fields, "enabled"))
        .frame(width: 150, alignment: .leading)
        .accessibilityIdentifier("workflow-detector-\(key)")
      if let threshold {
        Toggle("Set threshold", isOn: Binding(get: { fields.wrappedValue["threshold"]?.number != nil }, set: {
          if $0 { fields.wrappedValue["threshold"] = .number(threshold) }
          else { fields.wrappedValue.removeValue(forKey: "threshold") }
        })).accessibilityIdentifier("workflow-threshold-\(key)-custom")
          .help("Confidence threshold for this detector")
        if fields.wrappedValue["threshold"]?.number != nil {
          ConfigurationWorkflowFraction(title: "", id: "workflow-threshold-\(key)", fields: fields, key: "threshold", fallback: threshold, range: 0...1, sliderWidth: 100)
            .accessibilityLabel("\(title) confidence threshold")
        } else {
          Text("Detector default").font(.caption).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
    }
  }
  private func checkpointEditor(_ title: String, key: String) -> some View {
    let fields = workflowObject(policy, key)
    return ConfigurationSection(title: title) {
      Toggle("Scan enabled", isOn: workflowFlag(fields, "enabled"))
        .accessibilityIdentifier("workflow-checkpoint-\(key)")
      scanPicker("Scope", fields: fields, key: "scope", values: ["auto", "full", "diff"], id: "workflow-scope-\(key)")
      scanPicker("Secrets", fields: fields, key: "onSecret", values: ["block", "warn", "escalate"], id: "workflow-secret-\(key)")
      scanPicker("Personal data", fields: fields, key: "onPii", values: ["block", "warn", "escalate"], id: "workflow-pii-\(key)")
      scanPicker("Prompt injection", fields: fields, key: "onInjection", values: ["block", "warn", "escalate"], id: "workflow-injection-\(key)")
    }.frame(minWidth: 270)
  }
  private func scanPicker(_ title: String, fields: Binding<[String: ConfigurationJSON]>, key: String, values: [String], id: String) -> some View {
    Picker(title, selection: Binding(get: { fields.wrappedValue[key]?.string ?? values[0] }, set: { fields.wrappedValue[key] = .string($0) })) {
      ForEach(values, id: \.self) { Text($0.capitalized).tag($0) }
    }.accessibilityIdentifier(id)
  }
}
