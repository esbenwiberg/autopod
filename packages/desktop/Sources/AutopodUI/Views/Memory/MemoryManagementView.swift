import SwiftUI

/// Browse, approve, reject, and create memory entries.
public struct MemoryManagementView: View {
    public var entries: [MemoryEntry]
    public var scopeFilter: MemoryScope?
    public var onApprove: (String) -> Void
    public var onReject: (String) -> Void
    public var onDelete: (String) -> Void

    @State private var selectedScope: MemoryScope = .global
    @State private var showingCreate = false

    public init(
        entries: [MemoryEntry],
        scopeFilter: MemoryScope? = nil,
        onApprove: @escaping (String) -> Void = { _ in },
        onReject: @escaping (String) -> Void = { _ in },
        onDelete: @escaping (String) -> Void = { _ in }
    ) {
        self.entries = entries
        self.scopeFilter = scopeFilter
        self.onApprove = onApprove
        self.onReject = onReject
        self.onDelete = onDelete
    }

    private var displayedScope: MemoryScope {
        scopeFilter ?? selectedScope
    }

    private var filteredEntries: [MemoryEntry] {
        entries.filter { $0.scope == displayedScope }
    }

    private var pending: [MemoryEntry] { filteredEntries.filter { !$0.approved } }
    private var approved: [MemoryEntry] { filteredEntries.filter { $0.approved } }

    public var body: some View {
        VStack(spacing: 0) {
            if scopeFilter == nil {
                scopePicker
                Divider()
            }
            if filteredEntries.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if !pending.isEmpty {
                            pendingSection
                        }
                        if !approved.isEmpty {
                            approvedSection
                        }
                    }
                    .padding(16)
                }
            }
        }
    }

    // MARK: - Scope picker

    private var scopePicker: some View {
        HStack(spacing: 0) {
            ForEach(MemoryScope.allCases, id: \.self) { s in
                Button {
                    selectedScope = s
                } label: {
                    Text(s.label)
                        .font(.caption)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(selectedScope == s ? Color.accentColor.opacity(0.15) : Color.clear)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(selectedScope == s ? .primary : .secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    // MARK: - Pending suggestions

    private var pendingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "clock.badge.questionmark")
                    .foregroundStyle(.orange)
                Text("Pending Approval")
                    .font(.system(.subheadline).weight(.semibold))
                Text("\(pending.count)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.orange.opacity(0.1), in: Capsule())
            }
            ForEach(pending) { entry in
                memoryCard(entry, isPending: true)
            }
        }
    }

    // MARK: - Approved entries

    private var approvedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text("Active Memories")
                    .font(.system(.subheadline).weight(.semibold))
                Text("\(approved.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }
            ForEach(approved) { entry in
                memoryCard(entry, isPending: false)
            }
        }
    }

    // MARK: - Memory card

    private func memoryCard(_ entry: MemoryEntry, isPending: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Text(entry.path)
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                Spacer()
                Text("v\(entry.version)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if let sid = entry.createdBySessionId {
                    Text("by \(sid)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Text(entry.content)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isPending {
                HStack(spacing: 8) {
                    Button {
                        onApprove(entry.id)
                    } label: {
                        Label("Approve", systemImage: "checkmark")
                            .font(.caption)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .tint(.green)

                    Button {
                        onReject(entry.id)
                    } label: {
                        Label("Reject", systemImage: "xmark")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .tint(.red)
                }
            } else {
                HStack {
                    Spacer()
                    Button(role: .destructive) {
                        onDelete(entry.id)
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 10))
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isPending ? Color.orange.opacity(0.2) : Color.clear, lineWidth: 1)
        )
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "brain")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("No memories")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Agents can suggest memories using the memory_suggest tool")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}
