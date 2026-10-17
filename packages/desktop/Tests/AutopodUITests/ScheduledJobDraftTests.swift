import AutopodClient
import Testing
@testable import AutopodUI

@Test func scheduleEditsRetainUnknownLaunchFieldsAndTemplateDefaults() {
  let template = ScheduledJobTemplate(id: "template", name: "Triage", prompt: "Review {{service}}",
    fields: [.init(key: "service", label: "Service", required: true, defaultValue: "api")], createdAt: "", updatedAt: "")
  let selection: [String: ConfigurationJSON] = ["repositoryId": .string("repo"),
    "futureSelection": .object(["retained": .bool(true)]), "overrides": .object(["futureOption": .number(7)])]
  let job = ScheduledJob(id: "job", name: "Job", templateId: template.id, templateName: template.name,
    launch: selection, task: "Review api", cronExpression: "0 9 * * *", enabled: true,
    nextRunAt: "", lastRunAt: nil, lastPodId: nil, catchupPending: false, createdAt: "", updatedAt: "")
  var draft = ScheduledJobDraft(job: job, templates: [template], profiles: [])
  draft.cron = "0 10 * * *"
  #expect(draft.launch == selection)
  #expect(draft.fieldValues(template) == ["service": "api"])
  #expect(draft.canSave(template: template, composable: true))
  draft.fields["service"] = "  "
  #expect(!draft.canSave(template: template, composable: true))
}

@Test func scheduledEmptyWorkspaceRequiresExplicitProfileAndLegacyRemainsEditable() {
  let template = ScheduledJobTemplate(id: "t", name: "Task", prompt: "Task", createdAt: "", updatedAt: "")
  var draft = ScheduledJobDraft(job: nil, templates: [template], profiles: ["legacy"])
  draft.launch = ["emptyWorkspace": .bool(true)]
  #expect(!draft.canSave(template: template, composable: true))
  draft.launch["profileId"] = .string("profile")
  #expect(draft.canSave(template: template, composable: true))
  draft.launch = [:]
  #expect(draft.canSave(template: template, composable: false))
}

@MainActor @Test func scheduleRunTimesAcceptBothDaemonTimestampForms() {
  let plain = DesktopScheduleTime.label("2026-10-19T09:00:00Z")
  let fractional = DesktopScheduleTime.label("2026-10-19T09:00:00.000Z")
  #expect(plain != "Time unavailable")
  #expect(plain == fractional)
  #expect(DesktopScheduleTime.label("not a timestamp") == "Time unavailable")
}
