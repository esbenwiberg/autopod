import AutopodClient
import SwiftUI

extension EnvironmentValues {
    @Entry var desktopOpenManagedArtifact: ((ManagedArtifactSummary) -> Void)? = nil
}

/// Dispatcher-managed inventory remains distinct from native worker pods.
public struct DesktopManagedPodsWorkspace: View {
    public let pods: [ManagedPodSummary]
    @Binding public var selection: String?
    public let api: DaemonAPI?
    public var isLoading: Bool
    public var error: String?
    public var isConnected: Bool
    public var refresh: () async -> Void
    @State private var artifact: ManagedArtifactSummary?
    public init(pods: [ManagedPodSummary], selection: Binding<String?>, api: DaemonAPI?, isLoading: Bool,
                error: String?, isConnected: Bool, refresh: @escaping () async -> Void) {
        self.pods = pods; _selection = selection; self.api = api; self.isLoading = isLoading
        self.error = error; self.isConnected = isConnected; self.refresh = refresh
    }
    public var body: some View {
        VStack(spacing: 0) {
            if let artifact, let api {
                ManagedArtifactViewer(artifact: artifact, api: api, onClose: { self.artifact = nil })
            } else {
                DesktopInsightsHeader(title: "Managed pods", subtitle: "Follow a managed attempt from provider route to committed output.") {
                    HStack(spacing: 14) {
                        Label("Read-only inventory", systemImage: "lock.shield").font(.caption).foregroundStyle(.secondary)
                        Button { Task { await refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(isLoading || !isConnected)
                    }
                }
                HStack {
                    Text(isConnected ? "Refreshes every 5 seconds" : "Disconnected · last loaded inventory may be stale")
                    Spacer()
                    Text("Repository identity is not reported")
                }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 24).padding(.vertical, 13).background(DesktopTheme.canvas)
                GeometryReader { geometry in
                    if geometry.size.width >= 1050 {
                        HSplitView { inventory.frame(minWidth: 450, idealWidth: geometry.size.width * 0.5); inspector.frame(minWidth: 430) }
                    } else {
                        VStack(spacing: 0) {
                            inventory.frame(height: max(250, geometry.size.height * 0.4))
                            Divider(); inspector
                        }
                    }
                }
            }
        }.background(DesktopTheme.surface)
            .environment(\.desktopOpenManagedArtifact, { artifact = $0 })
            .onChange(of: selection) { _, _ in artifact = nil }
            .onChange(of: pods.map(\.id), initial: true) { _, ids in
                if selection == nil || !ids.contains(selection ?? "") { selection = ids.first }
            }
    }
    private var inventory: some View {
        ManagedPodsView(pods: pods, selection: $selection, isLoading: isLoading, error: error,
            onRefresh: refresh, isConnected: isConnected, embedded: true)
    }
    @ViewBuilder private var inspector: some View {
        if let pod = pods.first(where: { $0.id == selection }) { ManagedPodDetailView(pod: pod, api: api).id(pod.id) }
        else { ContentUnavailableView("Select an attempt", systemImage: "shippingbox", description: Text("Route, receipts and committed outputs appear here.")) }
    }
}
