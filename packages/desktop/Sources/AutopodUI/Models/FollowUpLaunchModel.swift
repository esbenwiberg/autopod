import AutopodClient
import Foundation
import Observation

internal enum FollowUpLaunchKind: String { case dependent, fork }
internal enum FollowUpSeriesPlacement: String, CaseIterable { case inherit, new, standalone }

/// Owns source binding, preview admission and the exact uncertain launch payload.
@Observable @MainActor internal final class FollowUpLaunchModel {
  let kind: FollowUpLaunchKind
  let initiator: Pod
  var selection = ComposableLaunchRequest()
  var original = true
  var parents: Set<String>
  var series: FollowUpSeriesPlacement
  var seriesName = ""
  var baseBranch = ""
  let newSeriesID = "series-\(UUID().uuidString)"
  private(set) var source: EffectiveLaunchPreview?
  private(set) var preview: EffectiveLaunchPreview?
  private(set) var reviewed: ComposableLaunchRequest?
  private(set) var pending: ComposableLaunchRequest?
  private(set) var busy = false
  private(set) var error: String?
  private(set) var createdID: String?
  private(set) var generation = 0
  private var boundConnection: String?
  private var connectionBound = false
  var dirty = false
  var jsonDirty = false
  var advanced = ""

  init(kind: FollowUpLaunchKind, initiator: Pod, connectionID: String? = nil) {
    self.kind = kind; self.initiator = initiator
    boundConnection = connectionID; connectionBound = connectionID != nil
    parents = [initiator.id]; series = initiator.seriesId == nil ? .standalone : .inherit
    selection.task = kind == .fork ? initiator.task : ""
  }
  var ready: Bool { preview != nil && reviewed == request && !jsonDirty && pending == nil && source != nil }
  var request: ComposableLaunchRequest {
    var value = original ? sourceSelection : selection
    value.task = selection.task
    value.source = source.map { LaunchSource(podId: initiator.id, digest: $0.digest, configuration: original ? "original" : "current") }
    value.expectedDigest = nil; value.requestId = nil
    var work: [String: ConfigurationJSON] = [:]
    if kind == .fork {
      if value.repositoryId != nil {
        work["startBranch"] = .string(initiator.branch)
        if let base = initiator.baseBranch { work["baseBranch"] = .string(base) }
      }
    } else {
      work["dependsOnPodIds"] = .array(parents.sorted().map(ConfigurationJSON.string))
      switch series {
      case .inherit:
        if let id = initiator.seriesId { work["seriesId"] = .string(id) }
        if let name = initiator.seriesName { work["seriesName"] = .string(name) }
        work["prMode"] = source?.fields["work"]?["prMode"]
        if work["prMode"]?.string == "single" { work["branch"] = .string(initiator.branch) }
      case .new:
        work["seriesId"] = .string(newSeriesID)
        work["seriesName"] = .string(seriesName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "series-\(initiator.id.prefix(8))" : seriesName)
      case .standalone: break
      }
      if !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { work["baseBranch"] = .string(baseBranch) }
    }
    value.work = work.isEmpty ? nil : work
    return value
  }
  private var sourceSelection: ComposableLaunchRequest {
    var value = ComposableLaunchRequest(repositoryId: source?.fields["repository"]?["id"]?.string,
      profileId: source?.fields["profileId"]?.string)
    value.repositorySetupId = source?.fields["repository"]?["setup"]?["id"]?.string
    if value.repositoryId == nil { value.emptyWorkspace = true }
    return value
  }
  func validation(candidates: [Pod]) -> String? {
    if source == nil { return "Load the source launch snapshot before continuing." }
    if selection.task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Describe the follow-up task." }
    if jsonDirty { return "Apply or reload the JSON draft before previewing." }
    if kind == .dependent {
      if parents.isEmpty { return "Select at least one parent." }
      let pods = Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
      if parents.contains(where: { id in guard let pod = pods[id] else { return true }; return [.failed, .killed, .killing].contains(pod.status) }) {
        return "A selected parent is unavailable or no longer eligible. Update the parent selection."
      }
    }
    return nil
  }
  private func bind(_ actions: LaunchConfigurationActions) -> Bool {
    if connectionBound, boundConnection != actions.connectionID {
      error = "Connection changed. Close this draft and reopen it on the original daemon before retrying."; return false
    }
    boundConnection = actions.connectionID; connectionBound = true; return true
  }
  func invalidate() { preview = nil; reviewed = nil; generation += 1 }
  func refreshSource(_ actions: LaunchConfigurationActions) async {
    guard !busy, pending == nil else { return }
    guard bind(actions) else { return }
    invalidate(); let token = generation; busy = true; error = nil
    defer { busy = false }
    do {
      let loaded = try await actions.readLaunch(initiator.id)
      guard token == generation else { return }
      guard !loaded.digest.isEmpty else { throw LaunchJSONError.invalid("The source snapshot has no digest.") }
      let first = source == nil; source = loaded
      let identity = sourceSelection
      if first { let task = selection.task; selection = identity; selection.task = task }
      else {
        selection.repositoryId = identity.repositoryId; selection.emptyWorkspace = identity.emptyWorkspace
        // Current selections remain a draft; refreshing the source does not erase them.
      }
    } catch { source = nil; self.error = error.localizedDescription }
  }
  func resolve(_ actions: LaunchConfigurationActions, candidates: [Pod]) async {
    guard !busy, pending == nil else { return }
    guard bind(actions) else { return }
    if let reason = validation(candidates: candidates) { error = reason; return }
    guard actions.capabilities["launchAvailable"]?.bool == true else { error = "Launch is unavailable on this connection."; return }
    busy = true; error = nil; let candidate = request; let token = generation
    defer { busy = false }
    do {
      let resolved = try await actions.resolve(candidate)
      guard token == generation, candidate == request, !jsonDirty else { return }
      guard !resolved.digest.isEmpty else { throw LaunchJSONError.invalid("The preview has no digest.") }
      preview = resolved; reviewed = candidate
    } catch { invalidate(); self.error = error.localizedDescription }
  }
  func submit(_ actions: LaunchConfigurationActions, candidates: [Pod]) async {
    guard !busy, bind(actions) else { return }
    if pending == nil {
      guard ready, validation(candidates: candidates) == nil, actions.capabilities["launchAvailable"]?.bool == true, let preview else { return }
      var value = request; value.expectedDigest = preview.digest; value.requestId = UUID().uuidString
      pending = value
    }
    guard let value = pending else { return }
    busy = true; error = nil
    defer { busy = false }
    do { createdID = try await actions.launch(value); dirty = false; pending = nil }
    catch {
      if FollowUpFailure.isDefiniteRejection(error) {
        pending = nil; invalidate(); self.error = "\(error.localizedDescription)\nDraft retained. Refresh the source snapshot and preview again."
      } else { self.error = "\(error.localizedDescription)\nResult unconfirmed. Retry the retained request without changing it." }
    }
  }
}

internal enum FollowUpFailure {
  static func isDefiniteRejection(_ error: any Error) -> Bool {
    guard let daemon = error as? DaemonError else { return false }
    switch daemon {
    case .badRequest, .notFound, .unauthorized: return true
    case .serverError(let status, _): return (400..<500).contains(status) && status != 408
    default: return false
    }
  }
}

internal enum FollowUpSelectionJSON {
  static let managed: Set<String> = ["repositoryId", "repositorySetupId", "emptyWorkspace", "profileId", "intent", "source", "task", "work", "requestId", "expectedDigest", "origin"]
  static func value(_ request: ComposableLaunchRequest) -> ConfigurationJSON {
    .object((LaunchComposerJSON.value(request).object ?? [:]).filter { !managed.contains($0.key) })
  }
  static func decode(_ text: String, preserving request: ComposableLaunchRequest) throws -> ComposableLaunchRequest {
    let edited = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(text.utf8))
    guard let fields = edited.object, Set(fields.keys).isDisjoint(with: managed) else {
      throw LaunchJSONError.invalid("Source, repository, profile, task, work and request identity are managed by the follow-up composer.")
    }
    var merged = (LaunchComposerJSON.value(request).object ?? [:]).filter { managed.contains($0.key) }
    merged.merge(fields) { _, new in new }
    let value = ConfigurationJSON.object(merged)
    let decoded = try ComposableLaunchRequest.decodeJSON(Data(value.formatted().utf8))
    guard LaunchComposerJSON.value(decoded) == value else { throw LaunchJSONError.invalid("This desktop cannot preserve every field. No JSON edits were applied.") }
    return decoded
  }
}
