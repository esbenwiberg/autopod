import AutopodClient
import SwiftUI

/// Sheet for spawning a new pod that depends on one or more existing pods
/// ("fan-in ready"). The initiating pod is pre-selected as a parent; other
/// in-flight pods in the same series (or any active pod if the initiator is
/// standalone) can be added with checkboxes.
///
/// On submit, the new pod is enqueued with `dependsOnPodIds = parentIds`,
/// matching the backend fan-in contract: it stays `queued` until *all*
/// selected parents reach `validated`.
public struct SpawnDependentSheet: View {
    @Binding public var isPresented: Bool
    public let initiator: Pod
    public let candidatePods: [Pod]
    public let actions: PodActions
    public let profileNames: [String]
    public var onPodCreated: ((String) -> Void)?

    public init(
        isPresented: Binding<Bool>,
        initiator: Pod,
        candidatePods: [Pod],
        actions: PodActions,
        profileNames: [String],
        onPodCreated: ((String) -> Void)? = nil
    ) {
        self._isPresented = isPresented
        self.initiator = initiator
        self.candidatePods = candidatePods
        self.actions = actions
        self.profileNames = profileNames
        self.onPodCreated = onPodCreated
    }

    @State private var task: String = ""
    @State private var selectedProfile: String = ""
    @State private var baseBranch: String = ""
    @State private var selectedParentIds: Set<String> = []
    @State private var seriesMode: SeriesMode = .inherit
    @State private var newSeriesName: String = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private enum SeriesMode: String {
        case inherit       // stay in initiator's series (if any)
        case startNew      // create a new series rooted at the initiator
        case standalone    // no series metadata
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Spawn follow-up pod")
                .font(.title2.weight(.semibold))
            Text("The new pod stays queued until every selected parent reaches validated.")
                .font(.caption)
                .foregroundStyle(.secondary)

            taskField
            parentList
            profilePicker
            seriesPicker
            baseBranchField

            if let err = errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Spacer(minLength: 0)

            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Button(isSubmitting ? "Launching…" : "Launch follow-up") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(submitDisabled)
            }
        }
        .padding(20)
        .frame(width: 560, height: 640)
        .onAppear { setupDefaults() }
    }

    private var submitDisabled: Bool {
        isSubmitting
            || task.trimmingCharacters(in: .whitespaces).isEmpty
            || selectedParentIds.isEmpty
            || selectedProfile.isEmpty
    }

    private func setupDefaults() {
        selectedParentIds = [initiator.id]
        if selectedProfile.isEmpty {
            let workerProfile = actions.workerProfileForProfile(initiator.profileName)
            selectedProfile = workerProfile ?? initiator.profileName
            if !profileNames.contains(selectedProfile), let first = profileNames.first {
                selectedProfile = first
            }
        }
        if initiator.seriesId == nil {
            seriesMode = .standalone
        }
    }

    // MARK: - Fields

    private var taskField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Task")
                .font(.subheadline.weight(.semibold))
            TextEditor(text: $task)
                .frame(minHeight: 80, maxHeight: 120)
                .font(.system(.body, design: .monospaced))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                )
        }
    }

    private var parentList: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Parent pods")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(selectedParentIds.count) selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(parentCandidates, id: \.id) { pod in
                        parentRow(pod)
                    }
                }
            }
            .frame(height: 120)
            .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    private var parentCandidates: [Pod] {
        var seen: Set<String> = [initiator.id]
        var list: [Pod] = [initiator]
        for pod in candidatePods where !seen.contains(pod.id) {
            if pod.id == initiator.id { continue }
            // Offer active and validated pods — not terminal failures or killed.
            switch pod.status {
            case .killed, .failed, .killing: continue
            default: break
            }
            seen.insert(pod.id)
            list.append(pod)
        }
        return list
    }

    private func parentRow(_ pod: Pod) -> some View {
        let isSelected = selectedParentIds.contains(pod.id)
        let isInitiator = pod.id == initiator.id
        return HStack(spacing: 8) {
            Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                .foregroundStyle(isSelected ? Color.accentColor : .secondary)
            StatusDot(status: pod.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(pod.id)
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                Text(pod.task.split(whereSeparator: \.isNewline).first.map(String.init) ?? pod.branch)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if isInitiator {
                Text("initiator")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(isSelected ? Color.accentColor.opacity(0.08) : .clear)
        .contentShape(Rectangle())
        .onTapGesture {
            if isSelected {
                selectedParentIds.remove(pod.id)
            } else {
                selectedParentIds.insert(pod.id)
            }
        }
    }

    private var profilePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Profile")
                .font(.subheadline.weight(.semibold))
            Picker("", selection: $selectedProfile) {
                ForEach(profileNames, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
        }
    }

    private var seriesPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Series")
                .font(.subheadline.weight(.semibold))
            Picker("", selection: $seriesMode) {
                if initiator.seriesId != nil {
                    Text("Join “\(initiator.seriesName ?? "series")”").tag(SeriesMode.inherit)
                }
                Text("Start a new series").tag(SeriesMode.startNew)
                Text("Standalone (no series)").tag(SeriesMode.standalone)
            }
            .pickerStyle(.radioGroup)
            if seriesMode == .startNew {
                TextField("Series name", text: $newSeriesName)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private var baseBranchField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Base branch (optional)")
                .font(.subheadline.weight(.semibold))
            TextField(initiator.branch, text: $baseBranch)
                .textFieldStyle(.roundedBorder)
        }
    }

    // MARK: - Submit

    private func submit() async {
        errorMessage = nil
        isSubmitting = true
        defer { isSubmitting = false }

        let parentIds = Array(selectedParentIds)
        let (seriesId, seriesName): (String?, String?) = {
            switch seriesMode {
            case .inherit:
                return (initiator.seriesId, initiator.seriesName)
            case .startNew:
                // Use the initiator id as a convenient unique series id; the
                // name is user-supplied (falls back to initiator's id prefix).
                let name = newSeriesName.isEmpty ? "series-\(initiator.id.prefix(8))" : newSeriesName
                return ("series-\(initiator.id)", name)
            case .standalone:
                return (nil, nil)
            }
        }()

        let id = await actions.spawnDependent(
            selectedProfile,
            task,
            parentIds,
            seriesId,
            seriesName,
            initiator.acceptanceCriteria,
            baseBranch.isEmpty ? nil : baseBranch
        )
        if let id {
            onPodCreated?(id)
            isPresented = false
        } else {
            errorMessage = "Spawn failed — check the daemon log."
        }
    }
}
