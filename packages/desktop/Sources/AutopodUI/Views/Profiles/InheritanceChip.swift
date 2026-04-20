import AutopodClient
import SwiftUI

/// A small pill shown next to a field label on derived profiles. Indicates
/// whether the field's value is inherited from the parent or explicitly
/// overridden on this profile. Clicking the chip flips the state.
///
/// - `inherited`: the child row stores `null` for this field. The UI shows
///   the parent's value (disabled/dimmed). Tap to seed with the parent
///   value and start overriding.
/// - `overridden`: the child has an explicit value. Tap (or the ↺ button)
///   clears it back to `null` — which `onReset` performs.
///
/// Merge-special fields (`smokePages`, `skills`, …) also get a separate
/// `MergeModePicker` to control merge-vs-replace.
public struct InheritanceChip: View {
    public let source: FieldSource
    /// Parent profile name — shown in the chip when inherited.
    public let parentName: String?
    /// When the user switches from inherited → overridden.
    public let onOverride: () -> Void
    /// When the user switches from overridden → inherited (reset to parent).
    public let onReset: () -> Void

    public init(
        source: FieldSource,
        parentName: String?,
        onOverride: @escaping () -> Void,
        onReset: @escaping () -> Void
    ) {
        self.source = source
        self.parentName = parentName
        self.onOverride = onOverride
        self.onReset = onReset
    }

    public var body: some View {
        switch source {
        case .inherited:
            Button(action: onOverride) {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 9))
                    Text(parentName.map { "Inherited · \($0)" } ?? "Inherited")
                        .font(.system(size: 10))
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .foregroundStyle(.secondary)
                .background(.quaternary, in: Capsule())
            }
            .buttonStyle(.plain)
            .help("Click to override — you'll be able to edit this field")
        case .own:
            HStack(spacing: 2) {
                Text("Overridden")
                    .font(.system(size: 10))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .foregroundStyle(Color.accentColor)
                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                Button(action: onReset) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 10))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Reset to parent's value")
            }
        case .merged:
            HStack(spacing: 2) {
                Text(parentName.map { "Merged with \($0)" } ?? "Merged")
                    .font(.system(size: 10))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .foregroundStyle(Color.orange)
                    .background(Color.orange.opacity(0.12), in: Capsule())
            }
            .help("Parent and child values are combined — use the Merge Mode picker to switch to replace.")
        }
    }
}

/// Segmented picker that controls whether a merge-special field merges with
/// the parent (default) or replaces it wholesale.
public struct MergeModePicker: View {
    @Binding public var mode: MergeMode
    public let fieldLabel: String
    public let parentName: String?

    public init(mode: Binding<MergeMode>, fieldLabel: String, parentName: String?) {
        self._mode = mode
        self.fieldLabel = fieldLabel
        self.parentName = parentName
    }

    public var body: some View {
        HStack(spacing: 8) {
            Picker("", selection: $mode) {
                Text("Merge with parent").tag(MergeMode.merge)
                Text("Replace parent").tag(MergeMode.replace)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 260)
            Text(mode == .merge
                 ? (parentName.map { "\(fieldLabel) from \($0) come first, then yours." } ?? "Merged with parent.")
                 : "Only your \(fieldLabel.lowercased()) are used — parent's are discarded.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
