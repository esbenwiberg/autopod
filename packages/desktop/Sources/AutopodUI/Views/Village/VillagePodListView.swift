import SwiftUI

/// Native, keyboard-accessible fleet list beside the map. Uses the same filtered snapshot.
struct VillagePodListView: View {
    let snapshot: VillageSnapshot
    let onSelect: (VillageActor) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Village pods").font(.headline)
                Spacer()
                Text("\(snapshot.actors.count)").foregroundStyle(.secondary)
            }
            .padding()
            Divider()
            if snapshot.actors.isEmpty {
                ContentUnavailableView("No pods match this view", systemImage: "shippingbox")
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(snapshot.actors) { actor in
                            Button { onSelect(actor) } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: actor.source == .managed ? "shippingbox" : "terminal")
                                        .foregroundStyle(actor.source == .managed ? Color.purple : Color.accentColor)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(actor.title).font(.headline).lineLimit(2)
                                        Text("\(actor.source == .managed ? "Managed" : "Native") · \(actor.status.replacingOccurrences(of: "_", with: " "))")
                                            .font(.caption).foregroundStyle(.secondary)
                                        Text(actor.profile).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                        if let activity = actor.activity {
                                            Text("\(isFresh(actor) && activity.isRecent ? "Recent" : "Earlier"): \(activity.label)")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        if !isFresh(actor) {
                                            Text("Last known state").font(.caption).foregroundStyle(.orange)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                }
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(actor.id == snapshot.selectedActorId ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("village-pod-\(actor.id)")
                        }
                    }
                    .padding()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func isFresh(_ actor: VillageActor) -> Bool {
        snapshot.connected && (actor.source == .managed ? snapshot.managedDataFresh : snapshot.activityStreamConnected)
    }
}
