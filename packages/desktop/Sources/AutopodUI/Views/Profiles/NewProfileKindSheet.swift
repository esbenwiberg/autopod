import SwiftUI

/// Small modal shown before the profile editor opens when creating a new
/// profile. Gives the user a clean choice between starting from scratch
/// (base profile) or deriving from an existing profile.
///
/// Derived profiles open with every field inherited — the user adds
/// overrides explicitly. Base profiles open in the classic editor.
public struct NewProfileKindSheet: View {
    public let availableParents: [String]
    public let onEmpty: () -> Void
    public let onDerived: (_ parent: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedParent: String
    @State private var kind: Kind = .base

    public enum Kind: Hashable {
        case base
        case derived
    }

    public init(
        availableParents: [String],
        onEmpty: @escaping () -> Void,
        onDerived: @escaping (_ parent: String) -> Void
    ) {
        self.availableParents = availableParents
        self.onEmpty = onEmpty
        self.onDerived = onDerived
        self._selectedParent = State(initialValue: availableParents.first ?? "")
        // If no parents exist, force Base.
        if availableParents.isEmpty {
            self._kind = State(initialValue: .base)
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("New Profile")
                    .font(.headline)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                        .font(.title3)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 12)

            Divider()

            VStack(alignment: .leading, spacing: 14) {
                Text("How should this profile start?")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                kindOption(
                    .base,
                    title: "Start empty",
                    subtitle: "A standalone profile with all fields configured from scratch.",
                    icon: "doc"
                )

                kindOption(
                    .derived,
                    title: "Derive from an existing profile",
                    subtitle: "Inherits everything — you only fill in the fields that should differ.",
                    icon: "arrow.turn.down.right",
                    enabled: !availableParents.isEmpty
                )

                if kind == .derived, !availableParents.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Parent profile")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Picker("", selection: $selectedParent) {
                            ForEach(availableParents, id: \.self) { name in
                                Text(name).tag(name)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .frame(maxWidth: 320)
                    }
                    .padding(.leading, 30)
                }
            }
            .padding(20)

            Spacer(minLength: 0)

            Divider()

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Continue") {
                    switch kind {
                    case .base:
                        onEmpty()
                    case .derived:
                        if !selectedParent.isEmpty {
                            onDerived(selectedParent)
                        }
                    }
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(kind == .derived && selectedParent.isEmpty)
            }
            .padding(16)
        }
        .frame(width: 520, height: 360)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    private func kindOption(
        _ value: Kind,
        title: String,
        subtitle: String,
        icon: String,
        enabled: Bool = true
    ) -> some View {
        let selected = kind == value
        Button {
            if enabled { kind = value }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !enabled {
                        Text("No existing profiles to derive from.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer()
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(selected ? Color.accentColor.opacity(0.08) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(
                        selected ? Color.accentColor.opacity(0.4) : Color.secondary.opacity(0.2),
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1.0 : 0.5)
    }
}
