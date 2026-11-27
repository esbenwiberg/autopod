import SwiftUI

/// Discovery from loaded fleet archive flags only, independent of the normal History filters.
enum PreviouslyArchivedPods {
    static let title = "History / Recovery"

    static func exactMatch(_ pods: [Pod], query: String) -> Pod? {
        let id = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return nil }
        return pods.first { $0.id == id && ($0.fleetArchivedAt != nil || $0.operatorDisposal != nil) }
    }

    static func matches(_ pods: [Pod], query: String, repositories: [String: DesktopRepository] = [:]) -> [Pod] {
        if let exact = exactMatch(pods, query: query) { return [exact] }

        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return pods.filter { pod in
            guard pod.fleetArchivedAt != nil || pod.operatorDisposal != nil else { return false }
            return needle.isEmpty || [
                pod.id, pod.desktopTitle, pod.task, pod.profileName, pod.profileLabel, repositories[pod.id]?.label ?? ""
            ].contains { $0.localizedStandardContains(needle) }
        }.sorted { $0.startedAt > $1.startedAt }
    }
}

struct PreviouslyArchivedPodsView: View {
    let pods: [Pod]
    let openPod: (String) -> Void
    @Environment(\.desktopRepositories) private var repositories
    @State private var query = ""

    var body: some View {
        let matches = PreviouslyArchivedPods.matches(pods, query: query, repositories: repositories)
        VStack(alignment: .leading, spacing: 12) {
            Text("Disposal receipts remain cleanup pending until physical closure is confirmed. Archived records retain their separate visibility-only meaning.")
                .font(.callout)
            Text("Search loaded disposal and archived records from any date or repository. Open a pod for retained history and cleanup diagnostics.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Search archived pods by ID, task, or repository", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("previously-archived-search")
                .onSubmit {
                    if let exact = PreviouslyArchivedPods.exactMatch(pods, query: query) {
                        openPod(exact.id)
                    }
                }
            if matches.isEmpty {
                ContentUnavailableView(
                    query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "No loaded archived pods" : "No matching archived pods",
                    systemImage: "archivebox"
                )
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(matches) { pod in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(pod.desktopTitle).font(.callout.weight(.medium))
                                Text("\(pod.id) · \(repositories[pod.id]?.label ?? pod.desktopRepositoryPlaceholder)")
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Text(pod.operatorDisposal.map { "\($0.intent.capitalized) · \($0.state)" } ?? pod.status.label).foregroundStyle(pod.status.color)
                                    Text("Started \(pod.startedAt, style: .date)").foregroundStyle(.secondary)
                                }
                            }
                            .font(.caption)
                            Spacer()
                            Button("Open pod") { openPod(pod.id) }
                                .accessibilityLabel("Open pod \(pod.id)")
                                .accessibilityIdentifier("previously-archived-open-\(pod.id)")
                        }
                        .padding(.vertical, 10)
                        Divider()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
