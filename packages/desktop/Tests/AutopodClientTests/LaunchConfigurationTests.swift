import AutopodClient
import Foundation
import Testing
@testable import AutopodDesktop

@Suite struct LaunchConfigurationTests {
  @Test func followUpKeepsSourceChoiceAndRejectsUnknownSourceFields() throws {
    var request = ComposableLaunchRequest(repositoryId: "repo", profileId: "profile", task: "Next task")
    request.source = LaunchSource(podId: "parent", digest: String(repeating: "a", count: 64), configuration: "original")
    request.work = ["dependsOnPodIds": .array([.string("parent")])]
    let data = try JSONEncoder().encode(request)
    #expect(try ComposableLaunchRequest.decodeJSON(data) == request)
    var value = try JSONDecoder().decode([String: ConfigurationJSON].self, from: data)
    var source = value["source"]?.object ?? [:]; source["overrideAuthority"] = .bool(true); value["source"] = .object(source)
    #expect(throws: (any Error).self) { try ComposableLaunchRequest.decodeJSON(JSONEncoder().encode(value)) }
  }
  @Test func seriesJournalPreservesSelectionAndRejectsChangedRetry() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    var request = CreateSeriesRequest(requestId: "series-retry", seriesName: "Feature",
      briefs: [ParsedBriefResponse(title: "Brief", task: "Implement", dependsOn: [])],
      launch: ["repositoryId": .string("repo"), "selections": .object(["githubAccessId": .null, "toolPackIds": .array([])])],
      specContextFiles: [SpecFilePayload(path: "specs/context.md", content: "Context")], prMode: "single")
    let path = try LaunchRequestJournal.saveSeries(request, directory: folder)
    let data = try Data(contentsOf: path)
    let body = try JSONDecoder().decode(ConfigurationJSON.self, from: data)
    #expect(body["profile"] == nil)
    #expect(body["autoApprove"] == nil)
    #expect(body["launch"] == .object(request.launch))
    #expect(try LaunchRequestJournal.saveSeries(request, directory: folder) == path)
    request.seriesName = "Changed"
    #expect(throws: (any Error).self) { try LaunchRequestJournal.saveSeries(request, directory: folder) }
    #expect(try Data(contentsOf: path) == data)
  }
  @Test func watcherEditPreservesNestedLaunchOverridesAndRevision() throws {
    let data = Data(#"{"id":"watch","revision":7,"ownerUserId":"operator","createdAt":"created","updatedAt":"updated","payload":{"name":"Issues","enabled":false,"labelPrefix":"autopod","launch":{"repositoryId":"repo","selections":{"githubAccessId":null,"toolPackIds":[]},"overrides":{"workflow":{"tokenBudget":10000}}},"targets":{"debug":{"repositoryId":"repo","profileId":"debug-profile"}}}}"#.utf8)
    let watcher = try JSONDecoder().decode(WatcherBindingResponse.self, from: data)
    let edit = WatcherBindingWrite(id: watcher.id, expectedRevision: watcher.revision, payload: watcher.payload)
    let body = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(edit))
    #expect(body["expectedRevision"] == .number(7))
    #expect(body["ownerUserId"] == nil)
    #expect(body["payload"] == .object(watcher.payload))
  }
  @Test func schedulePreservesCompleteSelectionAndDoesNotSendALegacyProfile() throws {
    var selection = try JSONDecoder().decode([String: ConfigurationJSON].self, from: fixture())
    for key in ["task", "work", "requestId", "expectedDigest"] { selection.removeValue(forKey: key) }
    let request = CreateScheduledJobRequest(templateId: "template", launch: selection, cronExpression: "0 9 * * *")
    let body = try JSONDecoder().decode([String: ConfigurationJSON].self, from: JSONEncoder().encode(request))
    #expect(body["profileName"] == nil)
    #expect(body["launch"] == .object(selection))
    var response = body
    response["id"] = .string("job"); response["name"] = .string("Daily"); response["templateName"] = .string("Daily")
    response["profileName"] = .null; response["task"] = .string("Scheduled work")
    response["nextRunAt"] = .string("2026-09-14"); response["catchupPending"] = .bool(false)
    response["createdAt"] = .string("2026-09-13"); response["updatedAt"] = .string("2026-09-13")
    let job = try JSONDecoder().decode(ScheduledJob.self, from: JSONEncoder().encode(response))
    #expect(job.profileName == nil)
    #expect(job.launch == selection)
    let update = UpdateScheduledJobRequest(launch: job.launch, enabled: false)
    let edited = try JSONDecoder().decode([String: ConfigurationJSON].self, from: JSONEncoder().encode(update))
    #expect(edited["launch"] == .object(selection))
  }
  private func fixture() throws -> Data {
    let packages = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try Data(contentsOf: packages.appendingPathComponent("shared/src/fixtures/composable-launch.json"))
  }
  @Test func preservesCompleteSharedRequestIncludingFalseEmptyNullAndSecretReferences() throws {
    let data = try fixture()
    let request = try ComposableLaunchRequest.decodeJSON(data)
    let original = try JSONDecoder().decode(ConfigurationJSON.self, from: data)
    let encoded = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(request))
    #expect(original == encoded)
    #expect(request.selections?.githubAccess == .noAccess)
    #expect(request.selections?.toolPackIds == [])
    #expect(request.overrides?.repositorySetup?["buildCommand"] == .null)
    #expect(request.overrides?.repositorySetup?["hasWebUi"] == .bool(false))
  }
  @Test func aiReplacementDropsOldRouteOverrideAndInvalidatesAdmission() throws {
    var request = try ComposableLaunchRequest.decodeJSON(fixture())
    request.expectedDigest = String(repeating: "a", count: 64)
    request.select(.ai, id: "new-ai")
    #expect(request.selections?.aiId == "new-ai")
    #expect(request.overrides?.ai == nil)
    #expect(request.overrides?.workflow != nil)
    #expect(request.requestId == nil)
    #expect(request.expectedDigest == nil)
  }
  @Test func defaultAccessAndExplicitNoneEncodeDifferently() throws {
    var request = ComposableLaunchRequest(repositoryId: "repo", task: "Task")
    request.selections = LaunchSelections()
    let defaults = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(request))
    #expect(defaults["selections"]?["githubAccessId"] == nil)
    request.selections?.githubAccess = .noAccess
    let cleared = try JSONDecoder().decode(ConfigurationJSON.self, from: JSONEncoder().encode(request))
    #expect(cleared["selections"]?["githubAccessId"] == .null)
  }
  @Test func rejectsUnknownLaunchFieldsRatherThanDroppingThem() {
    #expect(throws: (any Error).self) { try ComposableLaunchRequest.decodeJSON(Data(#"{"repositoryId":"repo","task":"Task","surprise":true}"#.utf8)) }
    #expect(throws: (any Error).self) { try ComposableLaunchRequest.decodeJSON(Data(#"{"repositoryId":"repo","task":"Task","overrides":{"inherit":true}}"#.utf8)) }
    #expect(throws: (any Error).self) { try ComposableLaunchRequest.decodeJSON(Data(#"{"repositoryId":"repo","task":"Task","selections":{"toolPackIds":null}}"#.utf8)) }
  }
  @Test func savedLaunchIsPrivateAndCannotBeOverwrittenByAnotherRequest() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("autopod-launch-journal-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    var request = try ComposableLaunchRequest.decodeJSON(fixture())
    let path = try LaunchRequestJournal.save(request, directory: directory)
    #expect(try ComposableLaunchRequest.decodeJSON(Data(contentsOf: path)) == request)
    #expect(try LaunchRequestJournal.save(request, directory: directory) == path)
    let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    request.task = "Different task"
    #expect(throws: (any Error).self) { try LaunchRequestJournal.save(request, directory: directory) }
  }
}
