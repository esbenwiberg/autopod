import AutopodClient
import SwiftUI

/// Awaited mutations keep the editor open until the daemon accepts a change.
@MainActor public struct MemoryWorkspaceActions {
    public var create: (MemoryScope, String?, String, String) async throws -> Void
    public var update: (String, String) async throws -> Void
    public var updateCandidate: (String, MemoryCandidateUpdate) async throws -> Void
    public init(create: @escaping (MemoryScope, String?, String, String) async throws -> Void,
                update: @escaping (String, String) async throws -> Void,
                updateCandidate: @escaping (String, MemoryCandidateUpdate) async throws -> Void) {
        self.create = create; self.update = update; self.updateCandidate = updateCandidate
    }
}

struct DesktopMemoryDraft: Equatable {
    var memoryID: String?
    var candidate: MemoryCandidate?
    var scope: MemoryScope = .global
    var scopeID = ""
    var path = ""
    var content = ""
    var rationale = ""
    var appliesWhen = ""
    var avoidWhen = ""
    var impact = ""
    var isNew: Bool { memoryID == nil && candidate == nil }
    var isValid: Bool {
        !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && (!isNew || scope == .global || !scopeID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    init(scope: MemoryScope = .global) { self.scope = scope }
    init(memory: MemoryEntry) {
        memoryID = memory.id; scope = memory.scope; scopeID = memory.scopeId ?? ""
        path = memory.path; content = memory.content
    }
    init(candidate: MemoryCandidate) {
        self.candidate = candidate; scope = candidate.scope; scopeID = candidate.scopeId
        path = candidate.path; content = candidate.content; rationale = candidate.rationale ?? ""
        appliesWhen = candidate.appliesWhen ?? ""; avoidWhen = candidate.avoidWhen ?? ""; impact = candidate.impactSummary
    }
    var candidateUpdate: MemoryCandidateUpdate? {
        guard let candidate else { return nil }
        func optional(_ s: String) -> String? { let t = s.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? nil : t }
        return MemoryCandidateUpdate(path: path.trimmingCharacters(in: .whitespacesAndNewlines), content: content,
            rationale: optional(rationale), kind: candidate.kind, tags: candidate.tags,
            appliesWhen: optional(appliesWhen), avoidWhen: optional(avoidWhen), confidence: candidate.confidence,
            sourceEvidence: candidate.sourceEvidence, impactSummary: impact.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

struct DesktopMemoryEditor: View {
    @Binding var draft: DesktopMemoryDraft
    let original: DesktopMemoryDraft
    let busy: Bool
    let error: String?
    let connected: Bool
    let cancel: () -> Void
    let save: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(draft.isNew ? "New memory" : draft.candidate != nil ? "Edit candidate draft" : "Edit memory content").font(.title3.weight(.semibold))
                Spacer(); Button("Back", action: cancel).disabled(busy)
            }.padding(24)
            Divider()
            ScrollView {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 24) { fields.frame(minWidth: 400); context.frame(width: 280) }
                    VStack(alignment: .leading, spacing: 24) { fields; context }
                }.padding(24)
            }
            Divider()
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Text("Changes stay in this draft if saving fails.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", action: cancel).disabled(busy)
                Button(draft.isNew ? "Create memory" : "Save changes", action: save)
                    .buttonStyle(.borderedProminent).disabled(busy || !connected || !draft.isValid || (!draft.isNew && draft == original))
            }.padding(18)
        }.background(DesktopTheme.surface)
    }
    private var fields: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 7) {
                Text("Path").font(.caption).foregroundStyle(.secondary)
                TextField("/conventions/commits.md", text: $draft.path).textFieldStyle(.roundedBorder)
                    .disabled(draft.memoryID != nil).accessibilityIdentifier("memory-editor-path")
            }
            editor("Content", text: $draft.content, height: 230)
            if draft.candidate != nil {
                editor("Rationale", text: $draft.rationale)
                editor("Applies when", text: $draft.appliesWhen)
                editor("Avoid when", text: $draft.avoidWhen)
                editor("Impact summary", text: $draft.impact)
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("memory-save-error") }
        }.disabled(busy)
    }
    private var context: some View {
        DesktopPanel(title: "Scope & review") {
            if draft.isNew {
                Picker("Scope", selection: $draft.scope) {
                    ForEach(MemoryScope.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                if draft.scope != .global {
                    TextField("Scope ID", text: $draft.scopeID).textFieldStyle(.roundedBorder)
                }
                Text("Manually created memories are approved immediately.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text(draft.scope.label).font(.callout.weight(.medium))
                Text(draft.scopeID.isEmpty ? "All repositories" : draft.scopeID).font(.caption).textSelection(.enabled)
                Text(draft.candidate == nil ? "Only content changes. Path, scope and provenance remain fixed." : "Saving this draft does not approve it. Kind, tags, confidence and source evidence are preserved.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.disabled(busy)
    }
    private func editor(_ title: String, text: Binding<String>, height: CGFloat = 90) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: text).font(.system(.callout, design: .monospaced)).scrollContentBackground(.hidden)
                .padding(10).frame(height: height).background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(DesktopTheme.line))
                .accessibilityIdentifier("memory-editor-\(title.lowercased())")
        }
    }
}
