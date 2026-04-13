import AppKit
import AutopodClient
import SwiftUI

/// Browse, approve, reject, and create memory entries.
public struct MemoryManagementView: View {
    public var entries: [MemoryEntry]
    public var scopeFilter: MemoryScope?
    public var onApprove: (String) -> Void
    public var onReject: (String) -> Void
    public var onDelete: (String) -> Void
    public var onEdit: ((String, String) -> Void)?
    public var onCreateMemory: ((MemoryScope, String?, String, String) -> Void)?
    public var scopeNameLookup: ((MemoryScope, String) -> String?)?

    @State private var selectedScope: MemoryScope = .global
    @State private var showingCreate = false
    @State private var editingEntry: MemoryEntry?
    @State private var copiedId: String?

    public init(
        entries: [MemoryEntry],
        scopeFilter: MemoryScope? = nil,
        onApprove: @escaping (String) -> Void = { _ in },
        onReject: @escaping (String) -> Void = { _ in },
        onDelete: @escaping (String) -> Void = { _ in },
        onEdit: ((String, String) -> Void)? = nil,
        onCreateMemory: ((MemoryScope, String?, String, String) -> Void)? = nil,
        scopeNameLookup: ((MemoryScope, String) -> String?)? = nil
    ) {
        self.entries = entries
        self.scopeFilter = scopeFilter
        self.onApprove = onApprove
        self.onReject = onReject
        self.onDelete = onDelete
        self.onEdit = onEdit
        self.onCreateMemory = onCreateMemory
        self.scopeNameLookup = scopeNameLookup
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
                HStack(spacing: 0) {
                    scopePicker
                    Spacer()
                    if onCreateMemory != nil {
                        Button {
                            showingCreate = true
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .help("New memory")
                        .padding(.trailing, 12)
                    }
                }
            } else if onCreateMemory != nil {
                HStack {
                    Spacer()
                    Button {
                        showingCreate = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .help("New memory")
                    .padding(.trailing, 12)
                    .padding(.top, 8)
                }
            }
            Divider()
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
        .sheet(isPresented: $showingCreate) {
            CreateMemorySheet(
                defaultScope: scopeFilter ?? selectedScope,
                scopeLocked: scopeFilter != nil,
                onCreate: { scope, scopeId, path, content in
                    onCreateMemory?(scope, scopeId, path, content)
                    showingCreate = false
                },
                onCancel: { showingCreate = false }
            )
        }
        .sheet(item: $editingEntry) { entry in
            EditMemorySheet(
                entry: entry,
                onSave: { id, content in
                    onEdit?(id, content)
                    editingEntry = nil
                },
                onCancel: { editingEntry = nil }
            )
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
                if let scopeId = entry.scopeId,
                   entry.scope != .global,
                   let scopeName = scopeNameLookup?(entry.scope, scopeId) {
                    Text("· \(scopeName)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer()
                Button {
                    copyId(entry.id)
                } label: {
                    Text(copiedId == entry.id ? "copied" : shortId(entry.id))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Click to copy full id: \(entry.id)")
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
                    if onEdit != nil {
                        Button {
                            editingEntry = entry
                        } label: {
                            Image(systemName: "pencil")
                                .font(.system(size: 10))
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.tertiary)
                    }
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

    private func shortId(_ id: String) -> String {
        id.count > 8 ? String(id.prefix(8)) : id
    }

    private func copyId(_ id: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(id, forType: .string)
        withAnimation(.easeOut(duration: 0.15)) { copiedId = id }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            withAnimation(.easeOut(duration: 0.3)) {
                if copiedId == id { copiedId = nil }
            }
        }
    }
}

// MARK: - Create memory sheet

struct CreateMemorySheet: View {
    let defaultScope: MemoryScope
    let scopeLocked: Bool
    let onCreate: (MemoryScope, String?, String, String) -> Void
    let onCancel: () -> Void

    @State private var scope: MemoryScope
    @State private var scopeId: String = ""
    @State private var path: String = ""
    @State private var content: String = ""

    init(
        defaultScope: MemoryScope,
        scopeLocked: Bool,
        onCreate: @escaping (MemoryScope, String?, String, String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.defaultScope = defaultScope
        self.scopeLocked = scopeLocked
        self.onCreate = onCreate
        self.onCancel = onCancel
        self._scope = State(initialValue: defaultScope)
    }

    private var isValid: Bool { !path.trimmingCharacters(in: .whitespaces).isEmpty && !content.trimmingCharacters(in: .whitespaces).isEmpty }
    private var resolvedScopeId: String? { scope == .global ? nil : scopeId.isEmpty ? nil : scopeId }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Image(systemName: "brain")
                    .foregroundStyle(.purple)
                Text("New Memory")
                    .font(.headline)
                Spacer()
                Button("Cancel", action: onCancel)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                Button("Save") {
                    onCreate(scope, resolvedScopeId, path.trimmingCharacters(in: .whitespaces), content)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isValid)
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Scope
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Scope")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        if scopeLocked {
                            Text(scope.label)
                                .font(.caption)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                        } else {
                            Picker("", selection: $scope) {
                                ForEach(MemoryScope.allCases, id: \.self) { s in
                                    Text(s.label).tag(s)
                                }
                            }
                            .pickerStyle(.segmented)
                        }
                    }

                    // Scope ID (hidden for global)
                    if scope != .global {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(scope == .profile ? "Profile name" : "Session ID")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            TextField(scope == .profile ? "my-app" : "abc12345", text: $scopeId)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.caption, design: .monospaced))
                        }
                    }

                    // Path
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Path")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextField("/conventions/commits.md", text: $path)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                        Text("Use a path-like key to organize memories, e.g. /conventions/commits.md")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }

                    // Content
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Content")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextEditor(text: $content)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 120)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                            )
                    }
                }
                .padding(16)
            }
        }
        .frame(width: 480)
    }
}

// MARK: - Edit memory sheet

struct EditMemorySheet: View {
    let entry: MemoryEntry
    let onSave: (String, String) -> Void
    let onCancel: () -> Void

    @State private var content: String

    init(entry: MemoryEntry, onSave: @escaping (String, String) -> Void, onCancel: @escaping () -> Void) {
        self.entry = entry
        self.onSave = onSave
        self.onCancel = onCancel
        self._content = State(initialValue: entry.content)
    }

    private var hasChanges: Bool { content != entry.content }
    private var isValid: Bool { !content.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Image(systemName: "pencil")
                    .foregroundStyle(.purple)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Edit Memory")
                        .font(.headline)
                    Text(entry.path)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel", action: onCancel)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                Button("Save") {
                    onSave(entry.id, content)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isValid || !hasChanges)
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Content")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextEditor(text: $content)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 200)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                            )
                    }
                }
                .padding(16)
            }
        }
        .frame(width: 480)
    }
}
