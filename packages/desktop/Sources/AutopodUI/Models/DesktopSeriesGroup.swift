import Foundation

/// Series completion counts successful delivery only; failed and killed members stay visible separately.
struct DesktopSeriesGroup: Identifiable {
    let id: String
    let pods: [Pod]
    var name: String { pods.first?.seriesName ?? id }
    var description: String? { pods.compactMap(\.seriesDescription).first { !$0.isEmpty } }
    var completedCount: Int { pods.filter { $0.status == .complete }.count }
    var failedCount: Int { pods.filter { $0.status == .failed || $0.status == .killed }.count }
    var attentionCount: Int { pods.filter { $0.status.needsAttention }.count }
    var queuedCount: Int { pods.filter { $0.status == .queued || $0.status == .paused }.count }
    var totalCost: Double { pods.reduce(0) { $0 + $1.costUsd } }
    var isActive: Bool { pods.contains { ![PodStatus.complete, .failed, .killed].contains($0.status) } }
    var completion: Double { pods.isEmpty ? 0 : Double(completedCount) / Double(pods.count) }
    var latestActivity: Date { pods.map(\.updatedAt).max() ?? .distantPast }

    static func groups(_ pods: [Pod], includeCompleted: Bool = false) -> [Self] {
        Dictionary(grouping: pods.filter { $0.seriesId != nil }, by: { $0.seriesId! })
            .map { Self(id: $0.key, pods: $0.value.sorted { $0.startedAt < $1.startedAt }) }
            .filter { includeCompleted || $0.isActive || $0.failedCount > 0 }
            .sorted { a, b in
                if a.isActive != b.isActive { return a.isActive }
                if a.latestActivity != b.latestActivity { return a.latestActivity > b.latestActivity }
                return a.id < b.id
            }
    }
}
