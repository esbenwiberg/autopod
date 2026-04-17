import AppKit
import SwiftUI

/// Full log viewer — streaming events with filters, auto-scroll, and search.
public struct LogStreamView: View {
    public let events: [AgentEvent]
    public let sessionBranch: String
    public var isLoading: Bool
    public var loadError: String?
    public var onReload: (() -> Void)?

    public init(
        events: [AgentEvent],
        sessionBranch: String,
        isLoading: Bool = false,
        loadError: String? = nil,
        onReload: (() -> Void)? = nil
    ) {
        self.events = events
        self.sessionBranch = sessionBranch
        self.isLoading = isLoading
        self.loadError = loadError
        self.onReload = onReload
    }

    @State private var activeFilters: Set<AgentEventType> = []
    @State private var searchText = ""
    @State private var pinnedToBottom = true
    @State private var expandedEventId: Int?
    @State private var showCopiedFeedback = false
    @State private var isNearBottom = true

    private var filteredEvents: [AgentEvent] {
        events.filter { event in
            // Always filter tool_result noise (same as CLI)
            !event.type.isNoise
            && (activeFilters.isEmpty || activeFilters.contains(event.type))
            && (searchText.isEmpty || event.summary.localizedCaseInsensitiveContains(searchText)
                || (event.detail?.localizedCaseInsensitiveContains(searchText) ?? false))
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            logContent
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        VStack(spacing: 8) {
            HStack {
                Image(systemName: "text.line.last.and.arrowtriangle.forward")
                    .foregroundStyle(.secondary)
                Text(sessionBranch)
                    .font(.system(.subheadline, design: .monospaced).weight(.medium))
                Spacer()
                Text("\(filteredEvents.count) events")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    copyLogsToClipboard()
                } label: {
                    Image(systemName: showCopiedFeedback ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(showCopiedFeedback ? .green : .secondary)
                .help("Copy logs to clipboard")
                .disabled(filteredEvents.isEmpty)
                Button {
                    pinnedToBottom.toggle()
                } label: {
                    Image(systemName: pinnedToBottom ? "arrow.down.to.line.circle.fill" : "arrow.down.to.line.circle")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(pinnedToBottom ? .blue : .secondary)
                .help(pinnedToBottom ? "Auto-scroll on" : "Auto-scroll off")
            }

            HStack(spacing: 6) {
                // Search
                HStack(spacing: 4) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                    TextField("Filter logs...", text: $searchText)
                        .textFieldStyle(.plain)
                        .font(.system(.caption, design: .monospaced))
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))

                Spacer()

                // Type filter pills
                ForEach([
                    AgentEventType.status, .toolUse, .fileChange,
                    .escalation, .plan, .progress, .error, .output,
                ], id: \.rawValue) { type in
                    filterPill(type)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    private func filterPill(_ type: AgentEventType) -> some View {
        let isActive = activeFilters.contains(type)
        return Button {
            if isActive { activeFilters.remove(type) }
            else { activeFilters.insert(type) }
        } label: {
            HStack(spacing: 3) {
                Image(systemName: type.icon)
                    .font(.system(size: 9))
                Text(type.label)
            }
            .font(.system(.caption2).weight(isActive ? .semibold : .regular))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(isActive ? type.color.opacity(0.15) : Color.clear)
            .foregroundStyle(isActive ? type.color : .secondary)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(isActive ? type.color.opacity(0.3) : Color(nsColor: .separatorColor), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Copy

    private func copySingleEvent(_ event: AgentEvent) {
        var line = "[\(event.timeString)] [\(event.type.label)]"
        if let tool = event.toolName { line += " (\(tool))" }
        line += " \(event.summary)"
        if let detail = event.detail {
            line += "\n    \(detail.replacingOccurrences(of: "\n", with: "\n    "))"
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(line, forType: .string)
    }

    private func copyLogsToClipboard() {
        let text = filteredEvents.map { event in
            var line = "[\(event.timeString)] [\(event.type.label)]"
            if let tool = event.toolName { line += " (\(tool))" }
            line += " \(event.summary)"
            if let detail = event.detail {
                line += "\n    \(detail.replacingOccurrences(of: "\n", with: "\n    "))"
            }
            return line
        }.joined(separator: "\n")

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)

        withAnimation(.easeOut(duration: 0.15)) { showCopiedFeedback = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            withAnimation(.easeOut(duration: 0.3)) { showCopiedFeedback = false }
        }
    }

    // MARK: - Log content

    private var logContent: some View {
        Group {
            if isLoading {
                VStack(spacing: 10) {
                    ProgressView()
                    Text("Loading logs…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = loadError {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 28))
                        .foregroundStyle(.red.opacity(0.8))
                    Text("Failed to load logs")
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                    if let onReload {
                        Button("Retry") { onReload() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .padding(.top, 4)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if events.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "text.line.last.and.arrowtriangle.forward")
                        .font(.system(size: 28))
                        .foregroundStyle(.tertiary)
                    Text("No log events recorded")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let onReload {
                        Button("Reload") { onReload() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .padding(.top, 4)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filteredEvents.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .font(.system(size: 24))
                        .foregroundStyle(.tertiary)
                    Text("No matching events")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ZStack(alignment: .bottomTrailing) {
                        ScrollView(.vertical) {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(filteredEvents) { event in
                                    LogEventRow(
                                        event: event,
                                        isExpanded: expandedEventId == event.id,
                                        onTap: {
                                            withAnimation(.easeOut(duration: 0.15)) {
                                                expandedEventId = expandedEventId == event.id ? nil : event.id
                                            }
                                        }
                                    )
                                    .contextMenu {
                                        Button {
                                            copySingleEvent(event)
                                        } label: {
                                            Label("Copy", systemImage: "doc.on.doc")
                                        }
                                    }
                                    .id(event.id)

                                    if event.id != filteredEvents.last?.id {
                                        Divider().padding(.leading, 80)
                                    }
                                }
                                // Anchor for scrolling to bottom
                                Color.clear.frame(height: 1).id("__bottom__")
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                        }
                        .onScrollGeometryChange(for: Bool.self) { geo in
                            geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 40
                        } action: { _, atBottom in
                            isNearBottom = atBottom
                            if atBottom { pinnedToBottom = true }
                        }
                        .onAppear {
                            proxy.scrollTo("__bottom__", anchor: .bottom)
                        }
                        .onChange(of: events.count) {
                            if pinnedToBottom {
                                proxy.scrollTo("__bottom__", anchor: .bottom)
                            }
                        }

                        // Scroll-to-bottom FAB
                        if !isNearBottom {
                            Button {
                                pinnedToBottom = true
                                withAnimation { proxy.scrollTo("__bottom__", anchor: .bottom) }
                            } label: {
                                Image(systemName: "arrow.down.to.line.circle.fill")
                                    .font(.system(size: 28))
                                    .foregroundStyle(.white)
                                    .shadow(radius: 4)
                            }
                            .buttonStyle(.plain)
                            .padding(16)
                            .transition(.opacity.combined(with: .scale(scale: 0.8)))
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Event row

struct LogEventRow: View {
    let event: AgentEvent
    let isExpanded: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 8) {
                // Timestamp
                Text(event.timeString)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(width: 55, alignment: .trailing)

                // Type indicator
                Image(systemName: event.type.icon)
                    .font(.system(size: 10))
                    .foregroundStyle(event.type.color)
                    .frame(width: 16)

                // Content
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.summary)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(event.type == .error ? .red : .primary)
                        .lineLimit(isExpanded ? nil : 1)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: isExpanded)

                    if isExpanded, let detail = event.detail {
                        Text(detail)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .padding(6)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .background(
                isExpanded
                    ? event.type.color.opacity(0.04)
                    : (event.type == .error ? Color.red.opacity(0.04) : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Previews

#Preview("Full log — running pod") {
    LogStreamView(events: MockEvents.running, sessionBranch: "refactor/api")
        .frame(width: 700, height: 500)
}

#Preview("Full log — failed pod") {
    LogStreamView(events: MockEvents.failed, sessionBranch: "fix/perf")
        .frame(width: 700, height: 400)
}

#Preview("Full log — awaiting input") {
    LogStreamView(events: MockEvents.awaitingInput, sessionBranch: "feat/oauth")
        .frame(width: 700, height: 350)
}
