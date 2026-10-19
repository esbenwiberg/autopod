import AutopodClient
import Foundation

/// Awaited mutations keep an editor open until the daemon confirms the write.
@MainActor public struct ScheduledWorkspaceActions {
  public var reload: () async throws -> Void
  public var run: (ScheduledJob, Bool) async throws -> String
  public var skip: (ScheduledJob) async throws -> Void
  public var create: (CreateScheduledJobRequest) async throws -> Void
  public var update: (String, UpdateScheduledJobRequest) async throws -> Void
  public var delete: (ScheduledJob) async throws -> Void
  public var createTemplate: (CreateScheduledJobTemplateRequest) async throws -> Void
  public var updateTemplate: (String, UpdateScheduledJobTemplateRequest) async throws -> Void
  public var deleteTemplate: (ScheduledJobTemplate) async throws -> Void

  public init(
    reload: @escaping () async throws -> Void,
    run: @escaping (ScheduledJob, Bool) async throws -> String,
    skip: @escaping (ScheduledJob) async throws -> Void,
    create: @escaping (CreateScheduledJobRequest) async throws -> Void,
    update: @escaping (String, UpdateScheduledJobRequest) async throws -> Void,
    delete: @escaping (ScheduledJob) async throws -> Void,
    createTemplate: @escaping (CreateScheduledJobTemplateRequest) async throws -> Void,
    updateTemplate: @escaping (String, UpdateScheduledJobTemplateRequest) async throws -> Void,
    deleteTemplate: @escaping (ScheduledJobTemplate) async throws -> Void
  ) {
    self.reload = reload; self.run = run; self.skip = skip
    self.create = create; self.update = update; self.delete = delete
    self.createTemplate = createTemplate; self.updateTemplate = updateTemplate
    self.deleteTemplate = deleteTemplate
  }
}

struct ScheduledJobDraft: Equatable {
  var templateID: String
  var profile: String
  var launch: [String: ConfigurationJSON]
  var cron: String
  var enabled: Bool
  var fields: [String: String]

  init(job: ScheduledJob?, templates: [ScheduledJobTemplate], profiles: [String], templateID: String? = nil) {
    self.templateID = job?.templateId ?? templateID ?? templates.sorted { $0.name < $1.name }.first?.id ?? ""
    profile = job?.profileName ?? profiles.sorted().first ?? ""
    launch = job?.launch ?? [:]; cron = job?.cronExpression ?? "0 9 * * 1-5"
    enabled = job?.enabled ?? true; fields = job?.fieldValues ?? [:]
  }
  func fieldValues(_ template: ScheduledJobTemplate?) -> [String: String] {
    Dictionary(uniqueKeysWithValues: (template?.fields ?? []).map { ($0.key, fields[$0.key] ?? $0.defaultValue ?? "") })
  }
  func canSave(template: ScheduledJobTemplate?, composable: Bool) -> Bool {
    guard let template, !templateID.isEmpty,
      cron.split(whereSeparator: \.isWhitespace).count == 5 else { return false }
    let destination = composable
      ? (launch["repositoryId"]?.string != nil || (launch["emptyWorkspace"]?.bool == true && launch["profileId"]?.string != nil))
      : !profile.isEmpty
    return destination && template.fields.allSatisfy {
      !$0.required || !(fields[$0.key] ?? $0.defaultValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }
}

/// Daemon timestamps can contain fractional seconds; keep their display zone explicit.
@MainActor public enum DesktopScheduleTime {
  public static func label(_ iso: String) -> String {
    let parser = ISO8601DateFormatter()
    let regular = parser.date(from: iso)
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = regular ?? parser.date(from: iso) else { return "Time unavailable" }
    let formatter = DateFormatter(); formatter.dateStyle = .medium; formatter.timeStyle = .short
    return formatter.string(from: date) + " " + (formatter.timeZone.abbreviation() ?? formatter.timeZone.identifier)
  }
}
