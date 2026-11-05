import AutopodClient
import Foundation

/// Keep filter identity separate from its catalog label: names can change or be shared.
struct DesktopProfileFilter: Identifiable, Equatable {
    let id: String
    let label: String
    let count: Int

    static func label(for id: String, documents: [ConfigurationDocument]) -> String {
        if let profile = documents.first(where: { $0.kind == .profile && $0.id == id }),
           !profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return profile.name
        }
        // Older daemons use human-readable profile names as the identity. Missing
        // catalog entries must not turn opaque IDs back into user-facing labels.
        let name = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let opaque = UUID(uuidString: name) != nil
            || name.range(of: #"^profile-[0-9a-fA-F]{24}$"#, options: .regularExpression) != nil
        return name.isEmpty || opaque ? "Profile unavailable" : name
    }

    static func rows(pods: [Pod], documents: [ConfigurationDocument]) -> [Self] {
        let groups = Dictionary(grouping: pods.filter { $0.fleetArchivedAt == nil }, by: \.profileName)
        return groups.map { id, pods in
            Self(id: id, label: label(for: id, documents: documents), count: pods.count)
        }.sorted {
            let order = $0.label.localizedStandardCompare($1.label)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }
}
