import SwiftUI

/// Compact log popover — shows last N events. Opens from card Logs button.
public struct LogPopover: View {
    public let events: [AgentEvent]
    public let sessionBranch: String
    public init(events: [AgentEvent], sessionBranch: String) {
        self.events = events; self.sessionBranch = sessionBranch
    }

    private var recentEvents: [AgentEvent] {
        Array(events.suffix(8))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text(sessionBranch)
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                Spacer()
                Text("\(events.count) total")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)

            Divider()

            // Recent events
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(recentEvents) { event in
                        HStack(alignment: .top, spacing: 6) {
                            Text(event.timeString)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .frame(width: 48, alignment: .trailing)

                            Circle()
                                .fill(event.type.color)
                                .frame(width: 5, height: 5)
                                .padding(.top, 5)

                            Text(event.summary)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(event.type == .error ? .red : .primary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)

                        if event.id != recentEvents.last?.id {
                            Divider().padding(.leading, 66)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(maxHeight: 250)

            Divider()

            // Footer
            HStack {
                Spacer()
                Button("Open Full Log") {}
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .foregroundStyle(.blue)
                Spacer()
            }
            .padding(.vertical, 6)
        }
        .frame(width: 380)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

// MARK: - Previews

#Preview("Log popover — running") {
    LogPopover(events: MockEvents.running, sessionBranch: "refactor/api")
}

#Preview("Log popover — failed") {
    LogPopover(events: MockEvents.failed, sessionBranch: "fix/perf")
}

#Preview("Log popover — short") {
    LogPopover(events: MockEvents.awaitingInput, sessionBranch: "feat/oauth")
}
