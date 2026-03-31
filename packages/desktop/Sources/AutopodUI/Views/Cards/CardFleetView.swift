import SwiftUI

public struct CardFleetView: View {
    public let sessions: [Session]
    public init(sessions: [Session]) { self.sessions = sessions }

    private var attention: [Session] { sessions.filter { $0.status.needsAttention } }
    private var active: [Session] { sessions.filter { $0.status.isActive } }
    private var completed: [Session] { sessions.filter { [.complete, .killed].contains($0.status) } }
    private var queued: [Session] { sessions.filter { [.queued, .provisioning].contains($0.status) } }

    private let columns = [GridItem(.adaptive(minimum: 230), spacing: 12)]

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if !attention.isEmpty {
                    section("Needs Attention", sessions: attention, accent: .orange)
                }
                if !active.isEmpty {
                    section("Running", sessions: active, accent: .green)
                }
                if !queued.isEmpty {
                    section("Queued", sessions: queued, accent: .secondary)
                }
                if !completed.isEmpty {
                    section("Completed", sessions: completed, accent: .secondary)
                }
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func section(_ title: String, sessions: [Session], accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(title.uppercased())
                    .font(.system(.caption, design: .default).weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("\(sessions.count)")
                    .font(.system(.caption2).weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(accent.opacity(0.15))
                    .foregroundStyle(accent)
                    .clipShape(Capsule())
            }
            LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                ForEach(sessions) { session in
                    SessionCard(session: session)
                }
            }
        }
    }
}

#Preview("Fleet view — all states") {
    CardFleetView(sessions: MockData.all)
        .frame(width: 900, height: 700)
}
