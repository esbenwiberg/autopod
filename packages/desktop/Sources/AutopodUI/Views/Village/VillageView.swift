import AutopodClient
import SwiftUI

/// Owns fleet presentation and filtering. The replaceable renderer never talks to the daemon.
public struct VillageView: View {
    let snapshotForDate: (Date) -> VillageSnapshot
    let isConnected: Bool
    let activityStreamConnected: Bool
    let managedError: String?
    let refreshManaged: (() async -> Void)?
    let onSelect: (VillageActor) -> Void

    @Binding var search: String
    @Binding var includeFinished: Bool
    @State private var rendererError: String?
    @State private var rendererGeneration = 0

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Label("Village", systemImage: "house.lodge.fill").font(.headline)
                Spacer()
                Toggle("Include finished", isOn: $includeFinished).toggleStyle(.checkbox)
                Button {
                    Task { await refreshManaged?() }
                } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh managed pods")
                .disabled(!isConnected)
            }
            .padding()
            TextField("Find a pod, profile or model", text: $search)
                .textFieldStyle(.roundedBorder).padding(.horizontal).padding(.bottom, 10)
            HStack {
                Circle().fill(isConnected && activityStreamConnected ? .green : .orange)
                    .frame(width: 7, height: 7)
                Text(!isConnected ? "Disconnected · last known state" :
                    activityStreamConnected ? "Live pod activity · managed stages refresh every 5 seconds" :
                    "Activity stream reconnecting · last known activity")
                Spacer()
            }
            .font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.bottom, 10)
            if let managedError {
                Text("Managed pods could not refresh: \(managedError)")
                    .font(.caption).foregroundStyle(.orange).padding(.horizontal).padding(.bottom, 8)
            }
            Divider()
            if let rendererError {
                ContentUnavailableView {
                    Label("Village could not load", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(rendererError)
                } actions: {
                    Button("Retry") { self.rendererError = nil; rendererGeneration += 1 }
                }
            } else {
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    VillageWebView(
                        snapshot: snapshotForDate(context.date),
                        onSelect: onSelect,
                        onFailure: { rendererError = $0 }
                    )
                    .id(rendererGeneration)
                }
            }
        }
        .task(id: isConnected) {
            guard isConnected, let refreshManaged else { return }
            while !Task.isCancelled {
                await refreshManaged()
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
    }

}
