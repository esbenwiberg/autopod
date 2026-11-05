import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@Test func profileFiltersResolveCatalogNamesWithoutChangingIdentityOrCounts() throws {
    let id = "344efd59-1111-4222-8333-123456789abc"
    let otherID = "48ae0f94-1111-4222-8333-123456789abc"
    let documents = [try filterProfile(id, name: "Backend"), try filterProfile(otherID, name: "Backend")]
    let pods = [filterPod("one", profile: id), filterPod("two", profile: id), filterPod("three", profile: otherID)]
    let rows = DesktopProfileFilter.rows(pods: pods, documents: documents)

    #expect(rows == [
        DesktopProfileFilter(id: id, label: "Backend", count: 2),
        DesktopProfileFilter(id: otherID, label: "Backend", count: 1),
    ])
    // Equal display names must not combine independent filters.
    #expect(pods.filter { $0.profileName == rows[0].id }.map(\.id) == ["one", "two"])
}

@Test func profileFiltersSortByNameAndExcludeFleetArchivedPods() throws {
    let a = try filterProfile("profile-aaaaaaaaaaaaaaaaaaaaaaaa", name: "Zulu", archived: true)
    let b = try filterProfile("profile-bbbbbbbbbbbbbbbbbbbbbbbb", name: "Alpha")
    var archived = filterPod("archived", profile: "unused")
    archived.fleetArchivedAt = "2026-11-05T00:00:00Z"
    let rows = DesktopProfileFilter.rows(pods: [filterPod("a", profile: a.id), filterPod("b", profile: b.id), archived], documents: [a, b])

    // Archived catalog entries still name the pods that used them.
    #expect(rows.map(\.label) == ["Alpha", "Zulu"])
    #expect(rows.map(\.count) == [1, 1])
}

@Test func profileFiltersHandleMissingCatalogAndLegacyNames() throws {
    let id = "78043925-1111-4222-8333-123456789abc"
    #expect(DesktopProfileFilter.label(for: id, documents: []) == "Profile unavailable")
    #expect(DesktopProfileFilter.label(for: "profile-123456789abcdef012345678", documents: []) == "Profile unavailable")
    #expect(DesktopProfileFilter.label(for: "", documents: []) == "Profile unavailable")
    #expect(DesktopProfileFilter.label(for: "autoreeve", documents: []) == "autoreeve")
    let unrelated = try filterProfile(id, name: "Not a profile", kind: .repository)
    #expect(DesktopProfileFilter.label(for: id, documents: [unrelated]) == "Profile unavailable")
    let blank = try filterProfile(id, name: "  ")
    #expect(DesktopProfileFilter.label(for: id, documents: [blank]) == "Profile unavailable")
}

@Test func profileFilterLabelsRefreshAfterCatalogLoadsOrProfileIsRenamed() throws {
    let id = "c6326e60-1111-4222-8333-123456789abc"
    let pods = [filterPod("pod", profile: id)]
    let before = DesktopProfileFilter.rows(pods: pods, documents: [])
    let loaded = DesktopProfileFilter.rows(pods: pods, documents: [try filterProfile(id, name: "Backend")])
    let renamed = DesktopProfileFilter.rows(pods: pods, documents: [try filterProfile(id, name: "API")])
    #expect(before.first?.label == "Profile unavailable")
    #expect(loaded.first?.label == "Backend")
    #expect(renamed.first?.label == "API")
    #expect(before.first?.id == renamed.first?.id)
}

private func filterPod(_ id: String, profile: String) -> Pod {
    Pod(id: id, status: .complete, branch: "test", profileName: profile, task: "Task", model: "Model", startedAt: Date())
}

private func filterProfile(_ id: String, name: String, archived: Bool = false, kind: ConfigurationKind = .profile) throws -> ConfigurationDocument {
    let data = try JSONSerialization.data(withJSONObject: [
        "id": id, "kind": kind.rawValue, "name": name, "revision": 1,
        "createdAt": "2026-11-05T00:00:00Z", "updatedAt": "2026-11-05T00:00:00Z",
        "archived": archived, "payload": [:],
    ])
    return try JSONDecoder().decode(ConfigurationDocument.self, from: data)
}
