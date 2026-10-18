import AutopodClient
import SwiftUI

internal enum LaunchComposerStage: Int, CaseIterable, Identifiable {
  case compose, configure, review
  var id: Int { rawValue }
  func title(series: Bool) -> String {
    switch self { case .compose: series ? "Briefs" : "Task"; case .configure: "Configuration"; case .review: "Review" }
  }
}

internal enum LaunchConfigurationSection: String, CaseIterable, Identifiable {
  case environment = "Environment", ai = "AI setup", workflow = "Workflow", github = "GitHub access"
  case tools = "Tool packs", execution = "Execution & size", pim = "PIM selections"
  case references = "Reference repositories", advanced = "Full launch JSON"
  var id: String { String(describing: self) }
  var subtitle: String {
    switch self {
    case .environment: "Build tools and optional services"
    case .ai: "Runtime, model and provider account"
    case .workflow: "Interaction and delivery rules"
    case .github: "Agent access and daemon delivery"
    case .tools: "Reusable tools for this task"
    case .execution: "Backend, allocation and sidecars"
    case .pim: "Eligible access for the same account"
    case .references: "Read-only source context"
    case .advanced: "Complete request and overrides"
    }
  }
}

internal enum LaunchComposerJSON {
  static func value<T: Encodable>(_ request: T) -> ConfigurationJSON {
    (try? JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(request))) ?? .null
  }
  static func value(_ request: ComposableLaunchRequest, selectionOnly: Bool) -> ConfigurationJSON {
    guard var fields = value(request).object else { return .null }
    if selectionOnly { for key in ["task", "work", "requestId", "expectedDigest", "origin"] { fields.removeValue(forKey: key) } }
    return .object(fields)
  }
  static func decode(_ text: String, selectionOnly: Bool, task: String) throws -> ComposableLaunchRequest {
    var value = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(text.utf8))
    if selectionOnly {
      guard var fields = value.object, Set(fields.keys).isDisjoint(with: ["task", "work", "requestId", "expectedDigest", "origin"]) else {
        throw LaunchJSONError.invalid("Task, work and request identity are supplied by the series.")
      }
      fields["task"] = .string(task); value = .object(fields)
    }
    let request = try ComposableLaunchRequest.decodeJSON(Data(value.formatted().utf8))
    guard self.value(request) == value else { throw LaunchJSONError.invalid("This desktop cannot preserve every JSON field. No changes were applied.") }
    return request
  }
}

/// A series review covers the exact create payload, including contracts and spec files.
/// Request identity is supplied only at submission; it cannot invalidate a matching review.
internal struct SeriesLaunchReview {
  let payload: ConfigurationJSON
  let configuration: EffectiveLaunchPreview
  var briefPreviews: [EffectiveLaunchPreview] = []
  static func fingerprint(_ request: CreateSeriesRequest) -> ConfigurationJSON {
    var value = LaunchComposerJSON.value(request).object ?? [:]
    value.removeValue(forKey: "requestId")
    return .object(value)
  }
  func matches(_ request: CreateSeriesRequest) -> Bool { payload == Self.fingerprint(request) }
}

@MainActor internal struct LaunchComposerContext {
  let request: ComposableLaunchRequest
  let actions: LaunchConfigurationActions
  var preview: EffectiveLaunchPreview? = nil
  var repository: ConfigurationDocument? { actions.list(.repository).first { $0.id == request.repositoryId } }
  var profile: ConfigurationDocument? { actions.list(.profile).first { $0.id == (request.profileId ?? repository?.payload["usualProfileId"]?.string) } }
  var repositoryName: String { repository?.name ?? request.repositoryId ?? (request.emptyWorkspace == true ? "Empty workspace" : "Choose a repository") }
  private func category(_ section: LaunchConfigurationSection) -> (ConfigurationKind, String, String)? {
    switch section {
    case .environment: (.environment, "environmentId", "environment")
    case .ai: (.ai, "aiId", "ai")
    case .workflow: (.workflow, "workflowId", "workflow")
    case .github: (.githubAccess, "githubAccessId", "githubAccess")
    default: nil
    }
  }
  func details(_ section: LaunchConfigurationSection) -> ConfigurationJSON {
    let fields = LaunchComposerJSON.value(request).object ?? [:]
    if section == .advanced { return .object(fields) }
    if section == .references { return fields["referenceRepositories"] ?? .array([]) }
    let resolvedKey: String? = switch section {
    case .environment: "environment"; case .ai: "ai"; case .workflow: "workflow"; case .github: "githubAccess"
    case .tools: "toolPacks"; case .pim: "pim"; default: nil
    }
    if let resolvedKey, let value = preview?.fields[resolvedKey] { return value }
    if section == .execution {
      if let resolved = preview?.fields["resolvedExecution"] { return resolved }
      return .object(merge(profile?.payload["execution"]?.object ?? [:], fields["overrides"]?["execution"]?.object ?? [:]))
    }
    if section == .pim { return fields["overrides"]?["pim"] ?? profile?.payload["pim"] ?? .array([]) }
    if section == .tools {
      if let edited = fields["overrides"]?["toolPacks"] { return edited }
      let ids = fields["selections"]?["toolPackIds"]?.array ?? profile?.payload["toolPackIds"]?.array ?? []
      return .array(ids.map { id in actions.list(.toolPack).first { $0.id == id.string }.map { .object($0.payload) } ?? id })
    }
    guard let (kind, key, override) = category(section) else { return .null }
    let selection = fields["selections"]?[key]
    if selection == .null { return .null }
    let id = selection?.string ?? profile?.payload[key]?.string
    var payload = actions.list(kind).first { $0.id == id }?.payload ?? [:]
    // Overrides are category patches; preserve nested preset values in draft summaries.
    payload = merge(payload, fields["overrides"]?[override]?.object ?? [:])
    return .object(payload)
  }
  private func merge(_ base: [String: ConfigurationJSON], _ edits: [String: ConfigurationJSON]) -> [String: ConfigurationJSON] {
    base.merging(edits) { old, new in
      if let a = old.object, let b = new.object { return .object(merge(a, b)) }; return new
    }
  }
  func origin(_ section: LaunchConfigurationSection) -> String {
    let fields = LaunchComposerJSON.value(request)
    if section == .advanced { return "Complete request" }
    if section == .references { return "Optional context" }
    let key = category(section)?.2 ?? (section == .tools ? "toolPacks" : section == .pim ? "pim" : "execution")
    if fields["overrides"]?[key] != nil { return "Launch override" }
    let selectionKey = category(section)?.1 ?? (section == .tools ? "toolPackIds" : "")
    return fields["selections"]?[selectionKey] == nil ? "Profile default" : "Selected for this launch"
  }
  func value(_ section: LaunchConfigurationSection) -> String {
    let data = details(section)
    switch section {
    case .ai: return [preview?.mainModel.nonEmpty ?? data["main"]?["model"]?.string, data["main"]?["runtime"]?.string].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? "Choose AI setup"
    case .execution:
      let target = preview?.executionTarget.nonEmpty ?? data["target"]?.string
      let memory = preview?.memoryGb ?? data["main"]?["memoryGb"]?.number
      return [target.map { $0 == "local" ? "Docker" : $0 == "sandbox" ? "Hosted sandbox" : $0 } ?? "Profile allocation", memory.map { "\($0.formatted()) GB" }].compactMap { $0 }.joined(separator: " · ")
    case .pim: return "\(data.array?.count ?? 0) selected roles"
    case .references: return "\(request.referenceRepositories?.count ?? 0) repositories"
    case .tools: return "\(data.array?.count ?? 0) tool pack\(data.array?.count == 1 ? "" : "s")"
    case .advanced: return "Complete request available"
    case .github where data == .null: return "No agent access"
    default:
      guard let (kind, key, _) = category(section) else { return "Profile default" }
      let id = LaunchComposerJSON.value(request)["selections"]?[key]?.string ?? profile?.payload[key]?.string
      return actions.list(kind).first { $0.id == id }?.name ?? "Profile default"
    }
  }
}

private extension String { var nonEmpty: String? { isEmpty ? nil : self } }

internal struct LaunchComposerLayout<Content: View, Summary: View, Footer: View>: View {
  let series: Bool
  @Binding var stage: LaunchComposerStage
  let locked: Bool
  let busy: Bool
  let ready: Bool
  let close: () -> Void
  @ViewBuilder let content: () -> Content
  @ViewBuilder let summary: () -> Summary
  @ViewBuilder let footer: () -> Footer
  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 8) {
          Text(series ? "SERIES / START WORK" : "FLEET / START WORK").font(.system(size: 9, weight: .medium)).tracking(1.3).foregroundStyle(.secondary)
          Text(series ? "New series" : "New pod").font(.title.weight(.semibold))
          Text(series ? "Read the briefs, inspect the plan and configure the pods together." : "Describe the work, inspect the configuration, then launch its resolved snapshot.").font(.callout).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Close", systemImage: "xmark", action: close).disabled(busy).keyboardShortcut(.cancelAction)
      }.padding(24).background(DesktopTheme.surface)
      Divider()
      GeometryReader { geometry in
        HStack(spacing: 0) {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(LaunchComposerStage.allCases) { item in
              Button { stage = item } label: {
                HStack(spacing: 10) {
                  Text(ready && item == .review ? "✓" : String(item.rawValue + 1)).font(.caption.monospacedDigit())
                    .frame(width: 24, height: 24).overlay(Circle().stroke(DesktopTheme.line))
                  Text(item.title(series: series)).font(.callout.weight(.medium))
                  Spacer(minLength: 0)
                }.padding(10).background(stage == item ? DesktopTheme.selection : .clear, in: RoundedRectangle(cornerRadius: 6))
                  .contentShape(Rectangle())
              }.buttonStyle(.plain).disabled(locked || busy).accessibilityIdentifier("launch-stage-\(item.rawValue)")
            }
            Text(locked ? "Exact request retained. Retry without editing." : "Move between stages freely. Your choices stay with this draft.")
              .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10)
            Spacer()
          }.padding(12).frame(width: 174).background(DesktopTheme.sidebar)
          Divider()
          ScrollView {
            VStack(alignment: .leading, spacing: 20) { content() }.padding(26).frame(maxWidth: .infinity, alignment: .topLeading)
          }.frame(maxWidth: .infinity)
          Divider()
          ScrollView { summary().padding(20).frame(maxWidth: .infinity, alignment: .topLeading) }
            .frame(width: geometry.size.width >= 1180 ? 300 : 246).background(DesktopTheme.sidebar)
        }
      }
      Divider()
      footer().padding(18).background(DesktopTheme.surface)
    }.background(DesktopTheme.canvas).tint(DesktopTheme.accent)
      .frame(minWidth: 900, idealWidth: 1280, maxWidth: .infinity, minHeight: 650, idealHeight: 850, maxHeight: .infinity)
  }
}

internal struct LaunchComposerSummary: View {
  let context: LaunchComposerContext
  var status = "Needs preview"
  var seriesPlan: String? = nil
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("LAUNCH SNAPSHOT").font(.system(size: 9, weight: .medium)).tracking(1.2).foregroundStyle(.secondary)
      Text(status).font(.caption).foregroundStyle(DesktopTheme.accent)
      Text(context.repositoryName).font(.headline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      fact("Profile", context.profile?.name ?? context.request.profileId ?? "Choose a profile", context.request.profileId == nil ? "Repository usual profile" : "Selected for this launch")
      ForEach([LaunchConfigurationSection.ai, .execution, .workflow, .github, .tools, .pim]) { item in
        fact(item.rawValue, context.value(item), item == .ai ? [context.details(.ai)["main"]?["providerAccountId"]?.string, context.origin(item)].compactMap { $0 }.joined(separator: " · ") : context.origin(item))
      }
      if let seriesPlan { fact("Series plan", seriesPlan, "Inspect dependencies in Briefs") }
      Text(context.preview == nil ? "These choices are a draft. Preview resolves the effective values and their sources." : "This preview covers the reviewed configuration. Every edit requires a fresh preview.")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
  private func fact(_ title: String, _ value: String, _ source: String) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      Text(value).font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
      Text(source).font(.caption2).foregroundStyle(.secondary)
      Divider().padding(.top, 7)
    }
  }
}

internal struct LaunchResolvedReview: View {
  let preview: EffectiveLaunchPreview
  var series = false
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Ready for this launch.").font(.title2.weight(.semibold))
      Text(series ? "Every brief has been checked. The daemon resolves the configuration again when admitting the series; edits require a fresh review." : "The preview pins the selected combination. Every edit requires a fresh preview.").font(.callout).foregroundStyle(.secondary)
      HStack { Label(preview.mainModel, systemImage: "sparkles"); Spacer(); Text(preview.executionTarget == "local" ? "Docker" : preview.executionTarget) }
      DisclosureGroup("Inspect complete resolved settings & value sources") {
        Text(ConfigurationJSON.object(preview.fields).formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
      }
    }
  }
}

internal struct LaunchRetainedRequest: View {
  let id: String
  let payload: ConfigurationJSON
  var series = false
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Label("Launch result unconfirmed", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
      Text("Retry the saved request.").font(.title2.weight(.semibold))
      Text("The response did not confirm the outcome. Configuration is locked so a retry uses the exact same identity and payload.")
        .font(.callout).foregroundStyle(.secondary)
      Text(id).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
      if series { Text("Saved at ~/.autopod/series-launches/\(id).json").font(.caption).textSelection(.enabled) }
      DisclosureGroup("Inspect retained payload") { Text(payload.formatted()).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
    }
  }
}
